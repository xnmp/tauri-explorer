use super::*;

#[test]
fn trail_keeps_only_the_newest_actions_in_order() {
    let mut trail = Trail::default();
    for index in 0..(MAX_ACTIONS + 5) {
        trail.record(&format!("cmd.n{index}"));
    }
    let rendered = trail.render();
    let lines: Vec<&str> = rendered.lines().collect();
    assert_eq!(lines.len(), MAX_ACTIONS);
    assert_eq!(lines[0], "1. cmd.n5");
    assert_eq!(
        lines[MAX_ACTIONS - 1],
        format!("{MAX_ACTIONS}. cmd.n{}", MAX_ACTIONS + 4)
    );
}

#[test]
fn identifiers_pass_through_and_anything_else_is_never_recorded() {
    for ok in ["navigate.up", "view:details", "plugin.git-badges_2"] {
        assert_eq!(sanitize(ok), ok);
    }
    for leaked in [
        "/home/alex/Documents/taxes.pdf",
        "C:\\Users\\alex\\file.txt",
        "search for my secret",
        "naïve",
        "",
        "   ",
        &"a".repeat(65),
    ] {
        assert_eq!(sanitize(leaked), "(unrecognized)", "{leaked:?}");
    }
}

#[test]
fn empty_trail_renders_nothing() {
    assert_eq!(Trail::default().render(), "");
}
