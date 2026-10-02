//! Keep the original SVG document vector-based and in its original viewport.
//! A separate clipped viewport selects pixel coordinates without rewriting
//! viewBox, percentages, root selectors, definitions or animated source nodes.
use super::{dimensions, failure, CropRect, Encoded, MAX_BYTES};
use crate::error::AppError;
use quick_xml::{
    events::{BytesEnd, BytesStart, Event},
    name::ResolveResult,
    reader::NsReader,
    Writer, XmlVersion,
};
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use std::{borrow::Cow, io::Write};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SvgViewport {
    pub width: u32,
    pub height: u32,
}

pub(super) fn candidate(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xfe])
        || bytes.starts_with(&[0xfe, 0xff])
        || bytes.starts_with(b"<\0")
        || bytes.starts_with(b"\0<")
        || bytes
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .unwrap_or(bytes)
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
            == Some(b'<')
}

fn xml_character(c: char) -> bool {
    matches!(c as u32, 9 | 10 | 13 | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
}

// XML 1.0 Fifth Edition NameStartChar / NameChar, excluding ':' for NCName.
// https://www.w3.org/TR/xml/#NT-NameStartChar
fn name_start(c: char) -> bool {
    matches!(c, 'A'..='Z' | '_' | 'a'..='z')
        || matches!(c as u32,
        0xc0..=0xd6 | 0xd8..=0xf6 | 0xf8..=0x2ff | 0x370..=0x37d |
        0x37f..=0x1fff | 0x200c..=0x200d | 0x2070..=0x218f |
        0x2c00..=0x2fef | 0x3001..=0xd7ff | 0xf900..=0xfdcf |
        0xfdf0..=0xfffd | 0x10000..=0xeffff)
}

fn qualified_name(value: &str) -> Result<(), AppError> {
    let mut count = 0;
    for part in value.split(':') {
        count += 1;
        let mut characters = part.chars();
        if count > 2
            || !characters.next().is_some_and(name_start)
            || !characters.all(|c| {
                name_start(c)
                    || matches!(c, '-' | '.' | '0'..='9')
                    || matches!(c as u32, 0xb7 | 0x300..=0x36f | 0x203f..=0x2040)
            })
        {
            return Err(failure("Invalid SVG XML name"));
        }
    }
    Ok(())
}

fn valid_characters(value: &str) -> Result<(), AppError> {
    if value.chars().all(xml_character) {
        Ok(())
    } else {
        Err(failure("Invalid SVG XML character"))
    }
}

/// CSS escaped dimension units can hide document-relative sizing. Normalize
/// escapes before the unit guard; bounded buffers retain the SVG byte contract.
fn document_units(value: &str) -> Result<bool, AppError> {
    use std::sync::LazyLock;
    static UNITS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?i)(?:^|[^a-z_0-9-])[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:[sld]?v(?:w|h|i|b|min|max)|r(?:em|ex|ch|ic|cap|lh)|cq(?:w|h|i|b|min|max))\b"
    ).expect("constant CSS dimension expression")
    });
    if !value.contains('\\') {
        return Ok(UNITS.is_match(value));
    }
    let mut normalized = String::new();
    normalized.try_reserve(value.len()).map_err(failure)?;
    let mut characters = value.chars().peekable();
    while let Some(mut character) = characters.next() {
        if character == '\\' {
            if characters.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                let mut code = 0;
                for _ in 0..6 {
                    let Some(digit) = characters.peek().and_then(|c| c.to_digit(16)) else {
                        break;
                    };
                    characters.next();
                    code = code * 16 + digit;
                }
                if characters.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                    let whitespace = characters.next();
                    // CSS preprocessing treats CRLF as one newline; numeric
                    // XML references can retain both characters here.
                    if whitespace == Some('\r') && characters.peek() == Some(&'\n') {
                        characters.next();
                    }
                }
                character = char::from_u32(code)
                    .filter(|c| *c != '\0')
                    .unwrap_or('\u{fffd}');
            } else if let Some(escaped) = characters.next() {
                character = escaped;
            }
        }
        if normalized.len().saturating_add(character.len_utf8()) > MAX_BYTES {
            return Err(failure("SVG CSS value exceeds the crop size limit"));
        }
        normalized
            .try_reserve(character.len_utf8())
            .map_err(failure)?;
        normalized.push(character);
    }
    Ok(UNITS.is_match(&normalized))
}

fn xml_text(bytes: &[u8]) -> Result<Cow<'_, str>, AppError> {
    if bytes.len() > MAX_BYTES {
        return Err(failure("SVG file exceeds the crop input limit"));
    }
    let little = bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(b"<\0");
    let big = bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(b"\0<");
    let text = if little || big {
        let bom =
            usize::from(bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff])) * 2;
        let data = &bytes[bom..];
        if data.len() % 2 != 0 {
            return Err(failure("Truncated UTF-16 SVG document"));
        }
        let mut words = Vec::new();
        words.try_reserve_exact(data.len() / 2).map_err(failure)?;
        words.extend(data.chunks_exact(2).map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        }));
        Cow::Owned(String::from_utf16(&words).map_err(failure)?)
    } else {
        Cow::Borrowed(std::str::from_utf8(bytes).map_err(failure)?)
    };
    if text.len() > MAX_BYTES || text.chars().any(|c| !xml_character(c)) {
        return Err(failure(
            "SVG text exceeds the crop limit or contains invalid XML characters",
        ));
    }
    Ok(text)
}

struct Root {
    width: Option<String>,
    height: Option<String>,
    dynamic_size: bool,
    context_dependent: bool,
    root_id: Option<String>,
    smil: bool,
    root_size_animation: bool,
    tag: BytesStart<'static>,
    body_start: usize,
    body_end: usize,
}

fn document(bytes: &[u8]) -> Result<Root, AppError> {
    let text = xml_text(bytes)?;
    let mut reader = NsReader::from_str(&text);
    reader.config_mut().check_comments = true;
    let mut root = None;
    let mut depth = 0_u32;
    let mut elements = 0_u32;
    let mut declaration_seen = false;
    let mut doctype_seen = false;
    let mut stylesheet_instruction = false;
    loop {
        let position = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(failure)?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                qualified_name(tag.name().as_ref())?;
                let (namespace, _) = reader.resolver().resolve_element(tag.name());
                if matches!(namespace, ResolveResult::Unknown(_)) {
                    return Err(failure("Undeclared SVG element namespace"));
                }
                elements += 1;
                if depth >= 512 || elements > 1_000_000 {
                    return Err(failure("SVG document exceeds the structural crop limit"));
                }
                if depth == 0 {
                    if root.is_some()
                        || tag.local_name().as_ref() != "svg"
                        || !matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == "http://www.w3.org/2000/svg")
                    {
                        return Err(failure("Expected one SVG document in the SVG namespace"));
                    }
                    root = Some(Root {
                        width: None,
                        height: None,
                        dynamic_size: false,
                        context_dependent: stylesheet_instruction,
                        root_id: None,
                        smil: false,
                        root_size_animation: false,
                        tag: tag.to_owned(),
                        body_start: reader.buffer_position() as usize,
                        body_end: reader.buffer_position() as usize,
                    });
                }
                let is_root = depth == 0;
                let root = root.as_mut().expect("root established before attributes");
                if tag.local_name().as_ref() == "style" {
                    root.dynamic_size = true;
                    root.context_dependent = true;
                }
                root.context_dependent |=
                    matches!(tag.local_name().as_ref(), "script" | "foreignObject");
                let animation = matches!(
                    tag.local_name().as_ref(),
                    "animate"
                        | "animateColor"
                        | "animateMotion"
                        | "animateTransform"
                        | "set"
                        | "discard"
                );
                root.smil |= animation;
                let mut animation_attribute = None;
                let mut animation_target = None;
                let mut xlink_target = None;
                for attribute in tag.attributes() {
                    let attribute = attribute.map_err(failure)?;
                    qualified_name(attribute.key.as_ref())?;
                    if attribute.value.contains('<') {
                        return Err(failure("Unescaped delimiter in SVG XML attribute"));
                    }
                    let attribute_namespace = reader.resolver().resolve_attribute(attribute.key).0;
                    if matches!(attribute_namespace, ResolveResult::Unknown(_)) {
                        return Err(failure("Undeclared SVG attribute namespace"));
                    }
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(failure)?;
                    valid_characters(&value)?;
                    if !matches!(
                        attribute.key.local_name().as_ref(),
                        "xmlns" | "id" | "class" | "href"
                    ) {
                        root.context_dependent |= document_units(&value)?;
                    }
                    if animation {
                        if attribute.key.as_ref() == "attributeName" {
                            animation_attribute = Some(value.to_string());
                        } else if attribute.key.as_ref() == "href" {
                            animation_target = Some(value.to_string());
                        } else if attribute.key.local_name().as_ref() == "href"
                            && matches!(attribute_namespace, ResolveResult::Bound(ns) if ns.as_ref() == "http://www.w3.org/1999/xlink")
                        {
                            xlink_target = Some(value.to_string());
                        }
                    }
                    if is_root {
                        match attribute.key.as_ref() {
                            "id" => root.root_id = Some(value.into_owned()),
                            "width" => root.width = Some(value.into_owned()),
                            "height" => root.height = Some(value.into_owned()),
                            "style" => root.dynamic_size = true,
                            _ => {}
                        }
                    }
                }
                // Unprefixed href takes precedence over XLink, independent of order.
                let targets_root = animation_target
                    .as_deref()
                    .or(xlink_target.as_deref())
                    .map_or(depth == 1, |target| {
                        target.trim().strip_prefix('#').is_some_and(|fragment| {
                            percent_encoding::percent_decode_str(fragment)
                                .decode_utf8()
                                .map_or(true, |id| {
                                    id.is_empty() || Some(id.as_ref()) == root.root_id.as_deref()
                                })
                        })
                    });
                root.root_size_animation |= targets_root
                    && animation_attribute.as_deref().is_some_and(|attribute| {
                        matches!(attribute, "width" | "height" | "x" | "y" | "style")
                    });
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => {
                if depth == 1 {
                    root.as_mut().expect("root established").body_end = position;
                }
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| failure("Unmatched SVG closing element"))?;
            }
            Event::Text(text) if depth == 0 && !text.as_ref().trim().is_empty() => {
                return Err(failure("Text outside the SVG document"));
            }
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => {
                return Err(failure("Content outside the SVG document"));
            }
            Event::PI(instruction) => {
                qualified_name(instruction.target())?;
                if instruction.target() == "xml-stylesheet" {
                    stylesheet_instruction = true;
                    if let Some(root) = &mut root {
                        root.context_dependent = true;
                    }
                }
            }
            Event::DocType(text) => {
                if root.is_some() || doctype_seen || text.as_ref().contains("<!ENTITY") {
                    return Err(failure("Unsupported SVG entity declarations"));
                }
                doctype_seen = true;
            }
            Event::Decl(declaration) => {
                if root.is_some() || declaration_seen || doctype_seen {
                    return Err(failure("Misplaced SVG XML declaration"));
                }
                let version = declaration.version().map_err(failure)?;
                if version != "1.0" {
                    return Err(failure("Unsupported SVG XML version"));
                }
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(failure)?.to_ascii_lowercase();
                    let little = bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(b"<\0");
                    let big = bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(b"\0<");
                    let matches_bytes = match encoding.as_str() {
                        "utf-8" => !little && !big,
                        "utf-16" => little || big,
                        "utf-16le" => little,
                        "utf-16be" => big,
                        _ => false,
                    };
                    if !matches_bytes {
                        return Err(failure("Unsupported or mismatched SVG text encoding"));
                    }
                }
                declaration_seen = true;
            }
            Event::GeneralRef(reference) => {
                if reference.as_ref().len() > 32 {
                    return Err(failure("Invalid SVG entity reference"));
                }
                let reference = format!("&{};", reference.as_ref());
                valid_characters(&quick_xml::escape::unescape(&reference).map_err(failure)?)?;
            }
            Event::Eof => {
                if depth != 0 {
                    return Err(failure("Truncated SVG document"));
                }
                return root.ok_or_else(|| failure("Empty SVG document"));
            }
            _ => {}
        }
    }
}

fn intrinsic_pixels(value: Option<&str>) -> Option<u32> {
    let value = value?.trim();
    let value = value.strip_suffix("px").unwrap_or(value).trim();
    let number: f64 = value.parse().ok()?;
    (number.is_finite() && number >= 1.0 && number <= 16384.0 && number.fract() == 0.0)
        .then_some(number as u32)
}

// WebKit SVGImage tracks SMIL in its own document, but not a nested SVG
// image resource. Keep ordinary SMIL in this document so its real animation
// controls the image timeline; do not add a dummy repaint animation.
fn animated_document(
    bytes: &[u8],
    root: &Root,
    viewport: SvgViewport,
    crop: CropRect,
) -> Result<Vec<u8>, AppError> {
    if root.context_dependent || root.root_size_animation {
        return Err(failure("Animated SVG cropping cannot preserve document-relative units, stylesheets, scripts, foreignObject or animated root dimensions; the original was not changed"));
    }
    let text = xml_text(bytes)?;
    let name = root.tag.name();
    let mut tag = BytesStart::new(name.as_ref());
    let mut style = String::new();
    let mut default_namespace = false;
    for attribute in root.tag.attributes() {
        let attribute = attribute.map_err(failure)?;
        default_namespace |= attribute.key.as_ref() == "xmlns";
        match attribute.key.as_ref() {
            "width" | "height" | "x" | "y" => {}
            "style" => {
                style = attribute
                    .normalized_value(XmlVersion::Implicit1_0)
                    .map_err(failure)?
                    .into_owned()
            }
            _ => tag.push_attribute(attribute),
        }
    }
    // Bind the original image viewport, including relative/unit/CSS dimensions.
    // x/y were ignored on the original image root and must not offset nesting.
    write!(
        style,
        ";width:{}px!important;height:{}px!important;x:0!important;y:0!important",
        viewport.width, viewport.height
    )
    .map_err(failure)?;
    // A prefixed root may originally have no default namespace. Do not let
    // the wrapper turn its unprefixed foreign nodes into SVG graphics.
    if !default_namespace {
        tag.push_attribute(("xmlns", ""));
    }
    tag.push_attribute(("style", style.as_str()));
    let width = viewport.width.to_string();
    let height = viewport.height.to_string();
    tag.push_attribute(("width", width.as_str()));
    tag.push_attribute(("height", height.as_str()));
    tag.push_attribute(("x", "0"));
    tag.push_attribute(("y", "0"));
    let mut output = Encoded::default();
    write!(output, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" style=\"overflow:hidden\">", crop.width(), crop.height(), crop.left, crop.top, crop.width(), crop.height()).map_err(failure)?;
    Writer::new(&mut output)
        .write_event(Event::Start(tag))
        .map_err(failure)?;
    output
        .write_all(text[root.body_start..root.body_end].as_bytes())
        .map_err(failure)?;
    Writer::new(&mut output)
        .write_event(Event::End(BytesEnd::new(name.as_ref())))
        .map_err(failure)?;
    output.write_all(b"</svg>").map_err(failure)?;
    Ok(output.into_bytes())
}

/// The captured browser viewport is authoritative for CSS/relative/unit sizing.
/// Simple integer/px intrinsic dimensions can also be used by pure codec callers.
pub(super) fn encode(
    bytes: &[u8],
    crop: CropRect,
    viewport: Option<SvgViewport>,
) -> Result<Vec<u8>, AppError> {
    let root = document(bytes)?;
    let viewport = viewport
        .or_else(|| {
            if root.dynamic_size {
                return None;
            }
            Some(SvgViewport {
                width: intrinsic_pixels(root.width.as_deref())?,
                height: intrinsic_pixels(root.height.as_deref())?,
            })
        })
        .ok_or_else(|| failure("SVG cropping requires its captured preview viewport"))?;
    dimensions(viewport.width, viewport.height)?;
    crop.validate(viewport.width, viewport.height)?;
    if root.smil {
        return animated_document(bytes, &root, viewport, crop);
    }
    let mut output = Encoded::default();
    write!(output, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" style=\"overflow:hidden\"><image x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" href=\"data:image/svg+xml;base64,", crop.width(), crop.height(), crop.left, crop.top, crop.width(), crop.height(), viewport.width, viewport.height).map_err(failure)?;
    {
        let mut encoded = base64::write::EncoderWriter::new(
            &mut output,
            &base64::engine::general_purpose::STANDARD,
        );
        encoded.write_all(bytes).map_err(failure)?;
        encoded.finish().map_err(failure)?;
    }
    output.write_all(b"\"/></svg>").map_err(failure)?;
    Ok(output.into_bytes())
}
