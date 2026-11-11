//! Wire-path contract (#1592, ADR 0031): bijection, canonicality and
//! structure preservation, plus the vectors shared with the frontend.
use super::*;
use proptest::prelude::*;
use std::borrow::Cow;

#[derive(serde::Deserialize)]
struct Fixture {
    vectors: Vec<Vector>,
    #[serde(rename = "nonCanonical")]
    non_canonical: Vec<NonCanonical>,
}

#[derive(serde::Deserialize)]
struct Vector {
    label: String,
    bytes: String,
    wire: String,
    display: String,
}

#[derive(serde::Deserialize)]
struct NonCanonical {
    label: String,
    wire: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../../tests/fixtures/wire-path.json")).unwrap()
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

#[test]
fn fixed_vectors_encode_decode_and_display() {
    for vector in fixture().vectors {
        let bytes = hex(&vector.bytes);
        assert_eq!(encode_bytes(&bytes), vector.wire, "encode {}", vector.label);
        assert_eq!(
            decode_bytes(&vector.wire).unwrap().as_ref(),
            bytes.as_slice(),
            "decode {}",
            vector.label
        );
        assert_eq!(
            lossy(&vector.wire),
            vector.display,
            "display {}",
            vector.label
        );
    }
}

#[cfg(unix)]
#[test]
fn fixed_vectors_round_trip_through_native_paths() {
    use std::os::unix::ffi::OsStrExt;
    for vector in fixture().vectors {
        let bytes = hex(&vector.bytes);
        let native = Path::new(OsStr::from_bytes(&bytes));
        assert_eq!(encode_path(native), vector.wire, "{}", vector.label);
        assert_eq!(
            decode(&vector.wire).unwrap().as_ref(),
            native,
            "{}",
            vector.label
        );
        assert_eq!(
            decode_name(&vector.wire).unwrap().as_bytes(),
            bytes.as_slice(),
            "{}",
            vector.label
        );
    }
}

#[test]
fn non_canonical_inputs_are_rejected() {
    for case in fixture().non_canonical {
        let error = decode_bytes(&case.wire).expect_err(&case.label);
        assert!(
            matches!(&error, AppError::InvalidPath(message) if message == "non-canonical path encoding"),
            "{}: {error:?}",
            case.label
        );
        assert!(decode(&case.wire).is_err(), "{}", case.label);
        assert!(decode_name(&case.wire).is_err(), "{}", case.label);
    }
}

#[test]
fn valid_utf8_without_reserved_characters_is_borrowed_unchanged() {
    for text in [
        "",
        "a.txt",
        "/home/user/é €/日本語.md",
        "\u{EF7F}\u{F000}",
        "\u{FFFD}",
    ] {
        assert!(matches!(encode_bytes(text.as_bytes()), Cow::Borrowed(t) if t == text));
        assert!(matches!(decode_bytes(text).unwrap(), Cow::Borrowed(b) if b == text.as_bytes()));
        assert!(matches!(decode(text).unwrap(), Cow::Borrowed(p) if p == Path::new(text)));
        assert!(matches!(lossy(text), Cow::Borrowed(t) if t == text));
        assert_eq!(refuse_escaped(text).unwrap(), text);
        assert!(matches!(native_text(text).unwrap(), Cow::Borrowed(t) if t == text));
    }
}

#[test]
fn native_text_decodes_genuine_reserved_characters_and_refuses_invalid_bytes() {
    for c in (0xEF80..=0xEFFF).map(|code| char::from_u32(code).unwrap()) {
        let name = format!("name{c}.txt");
        let wire = encode_bytes(name.as_bytes()).into_owned();
        assert_ne!(wire, name);
        assert_eq!(native_text(&wire).unwrap(), name);
    }
    let raw = encode_bytes(b"bad\xff.txt").into_owned();
    assert!(matches!(
        native_text(&raw),
        Err(AppError::InvalidPath(message)) if message == UNSUPPORTED_ENCODING
    ));
    // "é" spelled as escapes is not canonical (é encodes as itself).
    assert!(matches!(
        native_text("caf\u{EFC3}\u{EFA9}"),
        Err(AppError::InvalidPath(message)) if message != UNSUPPORTED_ENCODING
    ));
}

#[test]
fn refuse_escaped_rejects_every_reserved_character() {
    for c in (0xEF80..=0xEFFF).map(|code| char::from_u32(code).unwrap()) {
        let text = format!("name{c}.txt");
        let error = refuse_escaped(&text).unwrap_err();
        assert!(
            matches!(&error, AppError::InvalidPath(message) if message == UNSUPPORTED_ENCODING),
            "{error:?}"
        );
    }
}

/// Byte strings biased towards the interesting region: ASCII structure,
/// continuation bytes, lead bytes and the reserved character's encoding.
fn interesting_bytes() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(
        prop_oneof![
            Just(b'/'),
            Just(b'.'),
            Just(0u8),
            Just(0xEE),
            Just(0xBE),
            Just(0xBF),
            0x20u8..0x7F,
            0x80u8..0xC0,
            0xC0u8..=0xFF,
            any::<u8>(),
        ],
        0..24,
    )
}

/// Arbitrary strings that favour reserved characters and their look-alikes.
fn interesting_wire() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            (0xEF80u32..=0xEFFF).prop_map(|code| char::from_u32(code).unwrap()),
            Just('/'),
            Just('a'),
            Just('é'),
            Just('\u{FFFD}'),
            any::<char>(),
        ],
        0..12,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    #[test]
    fn decode_inverts_encode(bytes in interesting_bytes()) {
        let wire = encode_bytes(&bytes);
        prop_assert_eq!(decode_bytes(&wire).unwrap().into_owned(), bytes);
    }

    #[test]
    fn decode_inverts_encode_for_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..64)) {
        let wire = encode_bytes(&bytes);
        prop_assert_eq!(decode_bytes(&wire).unwrap().into_owned(), bytes);
    }

    /// Anything that decodes re-encodes to itself, so equal paths have equal
    /// wire strings and a wire string names exactly one path.
    #[test]
    fn anything_that_decodes_re_encodes_to_itself(wire in interesting_wire()) {
        if let Ok(bytes) = decode_bytes(&wire) {
            prop_assert_eq!(encode_bytes(&bytes), wire.as_str());
        }
    }

    #[test]
    fn distinct_byte_strings_have_distinct_wire_forms(
        a in interesting_bytes(),
        b in interesting_bytes(),
    ) {
        prop_assert_eq!(a == b, encode_bytes(&a) == encode_bytes(&b));
    }

    /// Escapes stand only for bytes >= 0x80, so every ASCII byte keeps its
    /// position: joins, splits and prefixes agree with the raw bytes.
    #[test]
    fn ascii_structure_is_preserved(a in interesting_bytes(), b in interesting_bytes()) {
        let joined = [a.as_slice(), b"/", b.as_slice()].concat();
        let expected = format!("{}/{}", encode_bytes(&a), encode_bytes(&b));
        prop_assert_eq!(encode_bytes(&joined), expected.as_str());
        let wire = encode_bytes(&joined);
        let wire_ascii: Vec<u8> = wire.bytes().filter(u8::is_ascii).collect();
        let raw_ascii: Vec<u8> = joined.iter().copied().filter(u8::is_ascii).collect();
        prop_assert_eq!(wire_ascii, raw_ascii);
    }

    #[test]
    fn display_text_matches_lossy_decoding_of_escape_runs(bytes in interesting_bytes()) {
        let wire = encode_bytes(&bytes);
        // Only invalid sequences differ from the bytes' own lossy decoding,
        // and both replace each maximal invalid subpart with one U+FFFD.
        prop_assert_eq!(lossy(&wire), String::from_utf8_lossy(&bytes));
    }
}

#[cfg(unix)]
proptest! {
    #![proptest_config(ProptestConfig::with_cases(2048))]

    /// `components()`, `parent()`, `file_name()` and `extension()` on the
    /// decoded path agree with the same operations on the wire spelling.
    #[test]
    fn path_structure_is_equivalent_on_wire_strings(bytes in interesting_bytes()) {
        use std::os::unix::ffi::OsStrExt;
        let bytes: Vec<u8> = bytes.into_iter().filter(|&byte| byte != 0).collect();
        let native = Path::new(OsStr::from_bytes(&bytes));
        let wire = encode_path(native).into_owned();
        let wire_path = Path::new(&wire);
        let native_components: Vec<_> = native.components().map(|c| encode(c.as_os_str()).into_owned()).collect();
        let wire_components: Vec<_> = wire_path.components().map(|c| c.as_os_str().to_str().unwrap().to_owned()).collect();
        prop_assert_eq!(native_components, wire_components);
        prop_assert_eq!(
            native.parent().map(|p| encode_path(p).into_owned()),
            wire_path.parent().map(|p| p.to_str().unwrap().to_owned())
        );
        prop_assert_eq!(
            native.file_name().map(|n| encode(n).into_owned()),
            wire_path.file_name().map(|n| n.to_str().unwrap().to_owned())
        );
        prop_assert_eq!(
            native.extension().map(|n| encode(n).into_owned()),
            wire_path.extension().map(|n| n.to_str().unwrap().to_owned())
        );
        prop_assert_eq!(
            native.parent().map(|p| encode_path(p).into_owned()),
            parent(&wire).map(str::to_owned)
        );
        prop_assert_eq!(
            native.file_name().map(|n| encode(n).into_owned()),
            file_name(&wire).map(str::to_owned)
        );
    }

    /// Joining wire spellings is the wire form of the native join, and stays
    /// canonical.
    #[test]
    fn join_is_the_wire_form_of_the_native_join(a in interesting_bytes(), b in interesting_bytes()) {
        use std::os::unix::ffi::OsStrExt;
        let a: Vec<u8> = a.into_iter().filter(|&byte| byte != 0).collect();
        let b: Vec<u8> = b.into_iter().filter(|&byte| byte != 0 && byte != b'/').collect();
        let native = Path::new(OsStr::from_bytes(&a)).join(OsStr::from_bytes(&b));
        let joined = join(&encode_bytes(&a), &encode_bytes(&b));
        prop_assert_eq!(&joined, &encode_path(&native).into_owned());
        prop_assert_eq!(decode(&joined).unwrap().into_owned(), native);
    }
}
