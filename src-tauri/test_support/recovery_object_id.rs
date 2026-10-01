use super::{Identity, ObjectId};
use serde_json::{json, Value};
use std::collections::HashSet;

fn identities() -> [ObjectId; 3] {
    [
        ObjectId(Identity::Linux {
            device: u64::MAX,
            inode: u64::MAX,
        }),
        ObjectId(Identity::Macos {
            device: u64::MAX,
            inode: u64::MAX,
        }),
        ObjectId(Identity::Windows {
            volume_serial: u64::MAX,
            file_id: [255; 16],
        }),
    ]
}

#[test]
fn native_identity_round_trips_and_foreign_platforms_are_rejected() {
    for identity in identities() {
        let encoded = serde_json::to_string(&identity).unwrap();
        let decoded = serde_json::from_str::<ObjectId>(&encoded);
        if identity.0.volume().0 == std::env::consts::OS {
            assert_eq!(decoded.unwrap(), identity);
            assert!(encoded.len() <= ObjectId::MAX_ENCODED_BYTES);
        } else {
            assert!(decoded.is_err(), "foreign identity accepted: {encoded}");
        }
    }
}

#[test]
fn windows_objects_differ_when_any_native_identity_bit_differs() {
    let base = ObjectId(Identity::Windows {
        volume_serial: u64::MAX,
        file_id: [0; 16],
    });
    let mut objects = HashSet::from([base]);
    for bit in 0..128 {
        let mut file_id = [0; 16];
        file_id[bit / 8] = 1 << (bit % 8);
        let next = ObjectId(Identity::Windows {
            volume_serial: u64::MAX,
            file_id,
        });
        assert_ne!(base, next);
        assert!(base.same_volume(next));
        assert!(objects.insert(next), "file ID bit {bit} was discarded");
    }
    assert_eq!(objects.len(), 129);
    for bit in 0..64 {
        let next = ObjectId(Identity::Windows {
            volume_serial: u64::MAX ^ (1 << bit),
            file_id: [0; 16],
        });
        assert_ne!(base, next);
        assert!(!base.same_volume(next), "volume bit {bit} was discarded");
    }
}

#[test]
fn equal_volume_numbers_do_not_alias_different_platforms() {
    let identities = identities();
    for (index, identity) in identities.iter().enumerate() {
        for (other_index, other) in identities.iter().enumerate() {
            assert_eq!(identity.same_volume(*other), index == other_index);
            assert_eq!(identity == other, index == other_index);
        }
    }
}

#[test]
fn unix_identity_preserves_full_device_and_inode_width() {
    for constructor in [
        |device, inode| ObjectId(Identity::Linux { device, inode }),
        |device, inode| ObjectId(Identity::Macos { device, inode }),
    ] {
        let base = constructor(u64::MAX, u64::MAX);
        for bit in 0..64 {
            let other_object = constructor(u64::MAX, u64::MAX ^ (1 << bit));
            assert_ne!(base, other_object);
            assert!(base.same_volume(other_object));
            let other_volume = constructor(u64::MAX ^ (1 << bit), u64::MAX);
            assert_ne!(base, other_volume);
            assert!(!base.same_volume(other_volume));
        }
    }
}

#[test]
fn identity_codec_rejects_untagged_unknown_and_malformed_authority() {
    let native = identities()
        .into_iter()
        .find(|id| id.0.volume().0 == std::env::consts::OS)
        .unwrap();
    let valid = serde_json::to_value(native).unwrap();
    let mut malformed = vec![Value::Null, json!({}), json!({"device": 1, "inode": 2})];
    for (field, invalid) in [
        ("platform", Value::Null),
        ("platform", json!("unsupported")),
        ("unexpected", json!(true)),
    ] {
        let mut value = valid.clone();
        value[field] = invalid;
        malformed.push(value);
    }
    let fields: &[&str] = if cfg!(windows) {
        &["volumeSerial", "fileId"]
    } else {
        &["device", "inode"]
    };
    for field in fields {
        for invalid in [Value::Null, json!(-1), json!(1.5), json!(1e100), json!("1")] {
            let mut value = valid.clone();
            value[*field] = invalid;
            malformed.push(value);
        }
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(*field);
        malformed.push(missing);
    }
    for value in malformed {
        assert!(
            serde_json::from_value::<ObjectId>(value.clone()).is_err(),
            "accepted {value}"
        );
    }
}

#[test]
fn windows_wire_contract_rejects_non_128_bit_identifiers() {
    // Exercise the Windows wire shape on every host. ObjectId adds native-OS
    // validation on top; fixed-width decoding must remain independently strict.
    for file_id in [
        json!([]),
        json!(vec![0; 15]),
        json!(vec![0; 17]),
        json!(vec![0; 65_536]),
        json!(vec![256; 16]),
        json!(vec![-1; 16]),
    ] {
        assert!(serde_json::from_value::<Identity>(json!({
            "platform": "windows", "volumeSerial": 1, "fileId": file_id
        }))
        .is_err());
    }
    let value = json!({"platform": "windows", "volumeSerial": u64::MAX, "fileId": vec![255; 16]});
    let identity: Identity = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(identity).unwrap(), value);
}
