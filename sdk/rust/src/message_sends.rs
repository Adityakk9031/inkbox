//! Recover the original message ID after losing a send response.

use crate::error::Result;
use crate::http::{validate_message_key, HttpTransport};
use std::sync::Arc;
use uuid::Uuid;

pub struct MessageSendsResource {
    http: Arc<HttpTransport>,
    mail: Arc<HttpTransport>,
}

impl MessageSendsResource {
    pub(crate) fn new(http: Arc<HttpTransport>, mail: Arc<HttpTransport>) -> Self {
        Self { http, mail }
    }

    /// Read the original ID without sending. Read its channel resource for status.
    pub fn lookup(
        &self,
        sender_kind: &str,
        sender_id: &Uuid,
        operation: &str,
        key: &str,
    ) -> Result<Uuid> {
        validate_message_key(key)?;
        let params = vec![
            ("sender_kind", sender_kind.to_string()),
            ("sender_id", sender_id.to_string()),
            ("operation", operation.to_string()),
        ];
        let data = self.http.get_with_headers(
            "/message-sends/lookup",
            &params,
            &[("Idempotency-Key", key)],
        )?;
        Ok(serde_json::from_value(data["message_id"].clone())?)
    }

    /// Resolve a sending mailbox by address before looking up its message key.
    pub fn lookup_email(&self, email_address: &str, operation: &str, key: &str) -> Result<Uuid> {
        let mailbox = self.mail.get(
            &format!("/mailboxes/{email_address}"),
            crate::http::NO_QUERY,
        )?;
        let id = serde_json::from_value(mailbox["id"].clone())?;
        self.lookup("mailbox", &id, operation, key)
    }
}
