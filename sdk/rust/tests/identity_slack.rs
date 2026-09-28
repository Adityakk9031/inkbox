use httpmock::{Method, MockServer};
use inkbox::identities::types::Unset;
use inkbox::Inkbox;
use serde_json::{json, Value};

#[test]
fn slack_channel_creation_and_reversible_update_preserve_old_defaults() {
    let server = MockServer::start();
    let client = Inkbox::builder("synthetic-test-key")
        .base_url(server.base_url())
        .build()
        .unwrap();
    let baseline: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/slack_identity.json")).unwrap();
    let old = server.mock(|when, then| {
        when.method(Method::POST)
            .path("/api/v1/identities/")
            .json_body(json!({"agent_handle":"support-agent"}));
        then.status(200).json_body(baseline.clone());
    });
    assert!(!client
        .create_identity("support-agent")
        .unwrap()
        .slack_enabled());
    old.assert_hits(1);
    let mut enabled = baseline.clone();
    enabled["slack_enabled"] = json!(true);
    let create = server.mock(|when, then| {
        when.method(Method::POST)
            .path("/api/v1/identities/")
            .json_body(json!({"agent_handle":"support-agent","slack_enabled":true}));
        then.status(200).json_body(enabled);
    });
    let identity = client
        .create_identity_with_channels(
            "support-agent",
            None,
            Unset::Omit,
            None,
            None,
            None,
            Unset::Omit,
            None,
            None,
            None,
            None,
            Some(true),
        )
        .unwrap();
    assert!(identity.slack_enabled());
    create.assert_hits(1);
    let mut disabled = baseline;
    disabled["slack_enabled"] = json!(false);
    let update = server.mock(|when, then| {
        when.method(Method::PATCH)
            .path("/api/v1/identities/support-agent")
            .json_body(json!({"slack_enabled":false}));
        then.status(200).json_body(disabled);
    });
    identity
        .update_with_channels(
            None,
            Unset::Omit,
            Unset::Omit,
            None,
            None,
            None,
            None,
            None,
            Unset::Omit,
            None,
            None,
            Some(false),
        )
        .unwrap();
    assert!(!identity.slack_enabled());
    update.assert_hits(1);
}

#[test]
fn slack_settings_survive_reads_refresh_and_metadata_scopes() {
    let server = MockServer::start();
    let client = Inkbox::builder("synthetic-test-key")
        .base_url(server.base_url())
        .build()
        .unwrap();
    let mut enabled: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/slack_identity.json")).unwrap();
    enabled["slack_enabled"] = json!(true);
    let mut get = server.mock(|when, then| {
        when.method(Method::GET)
            .path("/api/v1/identities/support-agent");
        then.status(200).json_body(enabled.clone());
    });
    let list = server.mock(|when, then| {
        when.method(Method::GET).path("/api/v1/identities/");
        then.status(200).json_body(json!([enabled.clone()]));
    });
    let identity = client.get_identity("support-agent").unwrap();
    assert!(identity.slack_enabled());
    let detailed = client
        .identities()
        .get_with_channels("support-agent")
        .unwrap();
    assert!(detailed.slack_enabled);
    assert_eq!(detailed.agent_handle, "support-agent");
    assert!(client.list_identities_with_channels().unwrap()[0].slack_enabled);
    identity
        .with_response_metadata(|scoped| {
            assert!(scoped.slack_enabled());
            Ok(())
        })
        .unwrap();
    get.assert_hits(2);
    list.assert_hits(1);
    get.delete();
    enabled["slack_enabled"] = json!(false);
    let refresh = server.mock(|when, then| {
        when.method(Method::GET)
            .path("/api/v1/identities/support-agent");
        then.status(200).json_body(enabled);
    });
    identity.refresh().unwrap();
    assert!(!identity.slack_enabled());
    refresh.assert_hits(1);
}
