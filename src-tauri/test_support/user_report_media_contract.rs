use super::*;
#[test]
fn native_media_signatures_match_frontend_and_relay_contract() {
    let contract: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/contract/fixtures/report_relay.json"
    ))
    .unwrap();
    for case in contract["mediaCases"].as_array().unwrap() {
        let attachment = ReportAttachment {
            name: case["name"].as_str().unwrap().into(),
            media_type: case["mediaType"].as_str().unwrap().into(),
            data: case["data"].as_str().unwrap().into(),
        };
        let result = validate_attachments(&[attachment]);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "case {}",
            case["name"]
        );
        if let Err(error) = result {
            assert_eq!(error.kind, "malformed_input");
        }
    }
}
