//! Cost bounds for a property list, checked before it is parsed (#1731).
//!
//! `plist::Value` expands a binary plist's shared object references into a
//! tree, so a few hundred bytes of references (object 0 = [1, 1],
//! object 1 = [2, 2], …) expand exponentially. A deep nesting also
//! overflows the stack, when the parsed value is dropped if not before.
//! Limits applied to the parsed value come too late. So, without
//! materialising anything:
//! - binary plists are walked through their offset table, computing the
//!   expanded node count and depth of each object once (memoised,
//!   iterative, cycle-checked);
//! - XML plists (which have no references) are scanned for element count
//!   and container depth.
//!
//! Anything over a limit is refused before `plist` sees it. Pure, so it is
//! tested on every host.

/// What a property list may cost to parse.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_bytes: usize,
    /// Expanded values (containers, keys and scalars).
    pub max_nodes: usize,
    /// Nested containers.
    pub max_depth: usize,
}

const BINARY_MAGIC: &[u8] = b"bplist00";
const TRAILER_LEN: usize = 32;

/// Ok when `bytes` is within `limits`, or a reason. Text that is not a
/// binary plist is checked as XML; whether it parses is left to `plist`.
pub fn check(bytes: &[u8], limits: &Limits) -> Result<(), String> {
    if bytes.len() > limits.max_bytes {
        return Err(format!(
            "{} bytes is more than the {} allowed",
            bytes.len(),
            limits.max_bytes
        ));
    }
    if bytes.starts_with(BINARY_MAGIC) {
        Binary::new(bytes, limits)?.check()
    } else {
        check_xml(bytes, limits)
    }
}

fn read_uint(bytes: &[u8], at: usize, size: usize) -> Option<u64> {
    let end = at.checked_add(size)?;
    Some(
        bytes
            .get(at..end)?
            .iter()
            .fold(0u64, |acc, b| (acc << 8) | u64::from(*b)),
    )
}

struct Binary<'a> {
    bytes: &'a [u8],
    limits: &'a Limits,
    offsets: Vec<usize>,
    ref_size: usize,
    top: usize,
}

impl<'a> Binary<'a> {
    fn new(bytes: &'a [u8], limits: &'a Limits) -> Result<Self, String> {
        let malformed = || "malformed binary property list".to_string();
        let trailer = bytes
            .len()
            .checked_sub(TRAILER_LEN)
            .filter(|&t| t >= BINARY_MAGIC.len())
            .ok_or_else(malformed)?;
        let t = &bytes[trailer..];
        let offset_size = usize::from(t[6]);
        let ref_size = usize::from(t[7]);
        if !(1..=8).contains(&offset_size) || !(1..=8).contains(&ref_size) {
            return Err(malformed());
        }
        let count = read_uint(t, 8, 8).ok_or_else(malformed)?;
        let top = read_uint(t, 16, 8).ok_or_else(malformed)?;
        let table = read_uint(t, 24, 8).ok_or_else(malformed)?;
        // Every object costs at least one node, so more objects than the
        // node budget cannot be within it (and this bounds the memo below).
        if count > limits.max_nodes as u64 {
            return Err(format!("{count} objects is more than allowed"));
        }
        let count = count as usize;
        if top >= count as u64 {
            return Err(malformed());
        }
        let table = usize::try_from(table).map_err(|_| malformed())?;
        let table_end = count
            .checked_mul(offset_size)
            .and_then(|len| table.checked_add(len))
            .ok_or_else(malformed)?;
        if table_end > trailer {
            return Err(malformed());
        }
        let offsets = (0..count)
            .map(|i| {
                read_uint(bytes, table + i * offset_size, offset_size)
                    .and_then(|o| usize::try_from(o).ok())
                    .filter(|&o| o >= BINARY_MAGIC.len() && o < table)
                    .ok_or_else(malformed)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Binary {
            bytes,
            limits,
            offsets,
            ref_size,
            top: top as usize,
        })
    }

    /// The object references of container `obj` (none for a scalar).
    fn children(&self, obj: usize) -> Result<Vec<usize>, String> {
        let malformed = || "malformed binary property list".to_string();
        let at = self.offsets[obj];
        let marker = self.bytes[at];
        let kind = marker >> 4;
        // 0xA array, 0xC set, 0xD dictionary (keys then values).
        if !matches!(kind, 0xA | 0xC | 0xD) {
            return Ok(vec![]);
        }
        let (len, start) = match marker & 0x0F {
            0x0F => {
                let int_marker = *self.bytes.get(at + 1).ok_or_else(malformed)?;
                if int_marker >> 4 != 0x1 || int_marker & 0x0F > 3 {
                    return Err(malformed());
                }
                let size = 1usize << (int_marker & 0x0F);
                let len = read_uint(self.bytes, at + 2, size).ok_or_else(malformed)?;
                (len, at + 2 + size)
            }
            short => (u64::from(short), at + 1),
        };
        let refs = if kind == 0xD {
            len.checked_mul(2).ok_or_else(malformed)?
        } else {
            len
        };
        if refs > self.limits.max_nodes as u64 {
            return Err("a container has more entries than allowed".into());
        }
        (0..refs as usize)
            .map(|i| {
                read_uint(self.bytes, start + i * self.ref_size, self.ref_size)
                    .filter(|&r| r < self.offsets.len() as u64)
                    .map(|r| r as usize)
                    .ok_or_else(malformed)
            })
            .collect()
    }

    /// Expanded size and depth from the top object, each object's
    /// subtree computed once.
    fn check(&self) -> Result<(), String> {
        const UNSEEN: u8 = 0;
        const OPEN: u8 = 1;
        const DONE: u8 = 2;
        let over = self.limits.max_nodes as u64 + 1;
        let n = self.offsets.len();
        let mut state = vec![UNSEEN; n];
        let mut nodes = vec![0u64; n];
        let mut depth = vec![0usize; n];
        // (object, its children, next child to visit)
        let mut stack = vec![(self.top, self.children(self.top)?, 0usize)];
        state[self.top] = OPEN;
        while let Some((obj, kids, next)) = stack.last_mut() {
            if let Some(&child) = kids.get(*next) {
                *next += 1;
                match state[child] {
                    UNSEEN => {
                        if stack.len() >= self.limits.max_depth {
                            return Err("nested deeper than allowed".into());
                        }
                        state[child] = OPEN;
                        let grandchildren = self.children(child)?;
                        stack.push((child, grandchildren, 0));
                    }
                    OPEN => return Err("malformed binary property list (cycle)".into()),
                    _ => {
                        if stack.len() + depth[child] > self.limits.max_depth {
                            return Err("nested deeper than allowed".into());
                        }
                    }
                }
                continue;
            }
            let obj = *obj;
            let size = kids
                .iter()
                .fold(1u64, |acc, &k| acc.saturating_add(nodes[k]))
                .min(over);
            let below = kids.iter().map(|&k| depth[k]).max().unwrap_or(0);
            nodes[obj] = size;
            depth[obj] = below + usize::from(!kids.is_empty() || self.is_container(obj));
            state[obj] = DONE;
            stack.pop();
        }
        if nodes[self.top] >= over {
            return Err("expands to more values than allowed".into());
        }
        Ok(())
    }

    fn is_container(&self, obj: usize) -> bool {
        matches!(self.bytes[self.offsets[obj]] >> 4, 0xA | 0xC | 0xD)
    }
}

/// Element count and container depth of an XML plist. Plist text cannot
/// contain a raw `<` outside markup, so a tag scan is exact enough to bound
/// the parser's work; comments, declarations and CDATA are skipped.
fn check_xml(bytes: &[u8], limits: &Limits) -> Result<(), String> {
    fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + from)
    }
    let (mut depth, mut nodes, mut i) = (0usize, 0usize, 0usize);
    while let Some(open) = find(bytes, i, b"<") {
        let rest = &bytes[open + 1..];
        let (skip_to, terminator): (usize, &[u8]) = if rest.starts_with(b"!--") {
            (open, b"-->")
        } else if rest.starts_with(b"![CDATA[") {
            (open, b"]]>")
        } else {
            (open, b">")
        };
        let Some(close) = find(bytes, skip_to + 1, terminator) else {
            // Unterminated markup: not a plist; the parser will say so.
            return Ok(());
        };
        let tag = &bytes[open + 1..close];
        i = close + terminator.len();
        if tag.starts_with(b"!") || tag.starts_with(b"?") {
            continue;
        }
        let is_container = |t: &[u8]| t.starts_with(b"array") || t.starts_with(b"dict");
        if let Some(name) = tag.strip_prefix(b"/") {
            if is_container(name) {
                depth = depth.saturating_sub(1);
            }
            continue;
        }
        nodes += 1;
        if nodes > limits.max_nodes {
            return Err("more values than allowed".into());
        }
        if is_container(tag) && !tag.ends_with(b"/") {
            depth += 1;
            if depth > limits.max_depth {
                return Err("nested deeper than allowed".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use plist::Value;
    use std::time::{Duration, Instant};

    const LIMITS: Limits = Limits {
        max_bytes: 1 << 20,
        max_nodes: 10_000,
        max_depth: 32,
    };

    /// Binary plist built by hand: `objects[i]` is either `Leaf(bytes)` or
    /// an array of object references (one-byte offsets/refs are not enough
    /// for large cases, so 4-byte offsets and 2-byte refs).
    enum Obj {
        Leaf(Vec<u8>),
        Array(Vec<u16>),
    }

    fn bplist(objects: &[Obj]) -> Vec<u8> {
        let mut out = BINARY_MAGIC.to_vec();
        let mut offsets = vec![];
        for obj in objects {
            offsets.push(out.len() as u32);
            match obj {
                Obj::Leaf(bytes) => out.extend_from_slice(bytes),
                Obj::Array(refs) => {
                    if refs.len() < 15 {
                        out.push(0xA0 | refs.len() as u8);
                    } else {
                        out.push(0xAF);
                        out.push(0x11);
                        out.extend_from_slice(&(refs.len() as u16).to_be_bytes());
                    }
                    for r in refs {
                        out.extend_from_slice(&r.to_be_bytes());
                    }
                }
            }
        }
        let table = out.len() as u64;
        for o in &offsets {
            out.extend_from_slice(&o.to_be_bytes());
        }
        out.extend_from_slice(&[0u8; 6]);
        out.push(4);
        out.push(2);
        out.extend_from_slice(&(offsets.len() as u64).to_be_bytes());
        out.extend_from_slice(&0u64.to_be_bytes());
        out.extend_from_slice(&table.to_be_bytes());
        out
    }

    fn ascii(s: &str) -> Obj {
        let mut v = vec![0x50 | s.len() as u8];
        v.extend_from_slice(s.as_bytes());
        Obj::Leaf(v)
    }

    /// object i = [i+1, i+1], last = a string: 2^levels values.
    fn dag(levels: usize) -> Vec<u8> {
        let mut objects: Vec<Obj> = (0..levels)
            .map(|i| Obj::Array(vec![(i + 1) as u16, (i + 1) as u16]))
            .collect();
        objects.push(ascii("file:///a.png"));
        bplist(&objects)
    }

    /// object i = [i+1], last = [].
    fn chain(levels: usize) -> Vec<u8> {
        let mut objects: Vec<Obj> = (0..levels)
            .map(|i| Obj::Array(vec![(i + 1) as u16]))
            .collect();
        objects.push(Obj::Array(vec![]));
        bplist(&objects)
    }

    fn deep_xml(levels: usize) -> Vec<u8> {
        let mut s = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist><plist version=\"1.0\">",
        );
        s.push_str(&"<array>".repeat(levels));
        s.push_str(&"</array>".repeat(levels));
        s.push_str("</plist>");
        s.into_bytes()
    }

    fn encode(v: &Value, binary: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if binary {
            v.to_writer_binary(&mut out).unwrap();
        } else {
            v.to_writer_xml(&mut out).unwrap();
        }
        out
    }

    #[test]
    fn ordinary_plists_from_the_plist_writer_pass_in_both_encodings() {
        let mut d = plist::Dictionary::new();
        d.insert(
            "a".into(),
            Value::Array(vec![Value::String("x".into()); 50]),
        );
        d.insert("b".into(), Value::Data(vec![1, 2, 3]));
        d.insert("c".into(), Value::Array(vec![]));
        let v = Value::Dictionary(d);
        for binary in [true, false] {
            assert_eq!(check(&encode(&v, binary), &LIMITS), Ok(()), "{binary}");
        }
        // The hand-built encoder agrees with the plist crate.
        assert!(Value::from_reader(std::io::Cursor::new(dag(3))).is_ok());
        assert_eq!(check(&dag(3), &LIMITS), Ok(()));
    }

    #[test]
    fn a_shared_reference_dag_is_refused_before_it_is_expanded() {
        // 2^40 values from a few hundred bytes: refused at once.
        let started = Instant::now();
        for levels in [14, 22, 30] {
            let blob = dag(levels);
            assert!(blob.len() < 1024);
            let err = check(&blob, &LIMITS).unwrap_err();
            assert!(err.contains("more values"), "{levels}: {err}");
        }
        // Past the depth limit it is refused for that first.
        assert!(check(&dag(60), &LIMITS).is_err());
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn deep_nesting_is_refused_without_recursion() {
        // A small stack proves the checks are iterative.
        let outcome = std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| {
                (
                    check(&chain(5_000), &LIMITS),
                    check(
                        &deep_xml(100_000),
                        &Limits {
                            max_bytes: 4 << 20,
                            ..LIMITS
                        },
                    ),
                )
            })
            .unwrap()
            .join()
            .unwrap();
        assert!(outcome.0.unwrap_err().contains("deeper"));
        assert!(outcome.1.unwrap_err().contains("deeper"));
        assert_eq!(check(&chain(LIMITS.max_depth - 1), &LIMITS), Ok(()));
        assert!(check(&chain(LIMITS.max_depth + 1), &LIMITS).is_err());
    }

    #[test]
    fn size_width_and_object_count_are_bounded() {
        let big = vec![b' '; LIMITS.max_bytes + 1];
        assert!(check(&big, &LIMITS).unwrap_err().contains("bytes"));

        let wide = bplist(&[Obj::Array(vec![1; LIMITS.max_nodes + 1]), ascii("x")]);
        assert!(check(&wide, &LIMITS).is_err());

        let many: Vec<Obj> = (0..=LIMITS.max_nodes).map(|_| ascii("x")).collect();
        assert!(check(&bplist(&many), &LIMITS)
            .unwrap_err()
            .contains("objects"));

        let xml_wide = format!(
            "<plist><array>{}</array></plist>",
            "<true/>".repeat(LIMITS.max_nodes + 1)
        );
        assert!(check(xml_wide.as_bytes(), &LIMITS).is_err());
    }

    #[test]
    fn malformed_binary_tables_are_refused_not_trusted() {
        let good = dag(2);
        let mut cases: Vec<Vec<u8>> = vec![b"bplist00".to_vec(), good[..good.len() - 1].to_vec()];
        // Reference past the object table.
        cases.push(bplist(&[Obj::Array(vec![7])]));
        // A cycle: 0 → 1 → 0.
        cases.push(bplist(&[Obj::Array(vec![1]), Obj::Array(vec![0])]));
        // Offset table pointing outside the file.
        let mut bad_offset = good.clone();
        let n = bad_offset.len();
        bad_offset[n - 8..].copy_from_slice(&(u64::MAX).to_be_bytes());
        cases.push(bad_offset);
        // Zero-sized refs.
        let mut zero_refs = good.clone();
        zero_refs[n - 25] = 0;
        cases.push(zero_refs);
        for (i, case) in cases.iter().enumerate() {
            assert!(check(case, &LIMITS).is_err(), "case {i}");
        }
    }

    #[test]
    fn xml_comments_and_cdata_do_not_confuse_the_scan() {
        let xml = b"<?xml version=\"1.0\"?><!-- <array><array> --><plist><array><string><![CDATA[<dict>]]></string><dict/></array></plist>";
        assert_eq!(
            check(
                xml,
                &Limits {
                    max_depth: 1,
                    ..LIMITS
                }
            ),
            Ok(())
        );
    }
}
