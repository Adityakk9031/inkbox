use httpmock::prelude::*;
use inkbox::contacts::types::Contact;
use inkbox::{
    Inkbox, SlackActorProfile, SlackConnectionsResponse, SlackSetupState, SlackWebhookPayload,
};
use serde_json::{json, Value};
use uuid::Uuid;
fn data() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/slack_setup_profiles.json"
    ))
    .unwrap()
}
#[test]
fn setup_uses_one_post_and_old_connections_still_parse() {
    let data = data();
    let server = MockServer::start();
    let client = Inkbox::builder("synthetic-test-key")
        .base_url(server.base_url())
        .build()
        .unwrap();
    let identity = Uuid::parse_str(data["identity_id"].as_str().unwrap()).unwrap();
    let create = server.mock(|when, then| {
        when.method(POST)
            .path("/api/v1/slack/applications/setup")
            .json_body(json!({"identity_id": identity}));
        then.status(202).json_body(data["setup"].clone());
    });
    let setup = client.slack().start_setup(identity).unwrap();
    assert_eq!(setup.status, SlackSetupState::Pending);
    assert_eq!(setup.retry_at.as_deref(), Some("2026-10-01T12:00:00Z"));
    create.assert();
    let old: SlackConnectionsResponse =
        serde_json::from_value(json!({"connections": [], "installation_available": true})).unwrap();
    assert!(old.setup.is_none());
    let current: SlackConnectionsResponse = serde_json::from_value(
        json!({"connections": [], "installation_available": true, "setup": data["setup"]}),
    )
    .unwrap();
    assert_eq!(current.setup.unwrap().status, SlackSetupState::Pending);
}
#[test]
fn sender_enrichment_and_linked_contacts_remain_optional() {
    let mut data = data();
    let payload: SlackWebhookPayload = serde_json::from_value(data["webhook"].clone()).unwrap();
    let sender = payload.data.actor_profile.unwrap();
    assert_eq!(sender.is_bot, Some(false));
    assert_eq!(sender.tz_offset, Some(0));
    assert_eq!(
        sender.profile.unwrap().email.as_deref(),
        Some("person@example.com")
    );
    assert_eq!(
        payload.data.contact_id.unwrap().to_string(),
        data["contact"]["id"]
    );
    let minimal: SlackActorProfile = serde_json::from_value(json!({"id": "UEXAMPLE"})).unwrap();
    assert!(minimal.profile.is_none());
    let card: Contact = serde_json::from_value(data["contact"].clone()).unwrap();
    assert_eq!(
        card.slack_accounts[0].workspace_name.as_deref(),
        Some("Example workspace")
    );
    assert_eq!(card.slack_accounts[1].user_id, "USECOND");
    data["contact"]
        .as_object_mut()
        .unwrap()
        .remove("slack_accounts");
    let old: Contact = serde_json::from_value(data["contact"].clone()).unwrap();
    assert!(old.slack_accounts.is_empty());
    data["webhook"]["data"]
        .as_object_mut()
        .unwrap()
        .remove("actor_profile");
    data["webhook"]["data"]
        .as_object_mut()
        .unwrap()
        .remove("contact_id");
    let old: SlackWebhookPayload = serde_json::from_value(data["webhook"].clone()).unwrap();
    assert!(old.data.actor_profile.is_none() && old.data.contact_id.is_none());
}
