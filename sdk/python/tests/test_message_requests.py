"""Request retries preserve logical send identity without changing message types."""

from unittest.mock import MagicMock
from uuid import UUID

import httpx
import pytest
from inkbox.exceptions import InkboxAPIError

from inkbox._message_requests import post_message, send_key
from inkbox.message_sends import MessageSendsResource


def test_network_retry_reuses_generated_key_and_body(monkeypatch):
    monkeypatch.setattr("inkbox._message_requests.time.sleep", lambda _: None)
    transport = MagicMock()
    transport.post.side_effect = [httpx.ReadTimeout("response lost"), {"id": "original"}]
    assert post_message(transport, "/messages", json={"text": "hello"}) == {"id": "original"}
    calls = transport.post.call_args_list
    assert calls[0] == calls[1]
    UUID(calls[0].kwargs["headers"]["Idempotency-Key"])
    assert calls[0].kwargs["headers"]["Prefer"] == "idempotency-replay"


def test_two_intended_messages_have_distinct_default_keys():
    transport = MagicMock()
    post_message(transport, "/messages", json={"text": "hello"})
    post_message(transport, "/messages", json={"text": "hello"})
    keys = [call.kwargs["headers"]["Idempotency-Key"] for call in transport.post.call_args_list]
    assert keys[0] != keys[1]


def test_explicit_key_preserved_after_exhausted_retries(monkeypatch):
    monkeypatch.setattr("inkbox._message_requests.time.sleep", lambda _: None)
    transport = MagicMock()
    transport.post.side_effect = httpx.ReadTimeout("response lost")
    with pytest.raises(httpx.ReadTimeout) as error:
        post_message(transport, "/messages", json={}, idempotency_key="same")
    assert error.value.idempotency_key == "same"
    assert transport.post.call_count == 3


@pytest.mark.parametrize("key", ["", " ", "a" * 256, "line\n", "é"])
def test_invalid_keys_are_rejected(key):
    with pytest.raises(ValueError):
        send_key(key)


def test_lookup_is_read_only_and_uses_key_header():
    transport, mailboxes = MagicMock(), MagicMock()
    identifier = UUID("10000000-0000-0000-0000-000000000001")
    transport.get.return_value = {"message_id": str(identifier)}
    result = MessageSendsResource(transport, mailboxes).lookup(sender_kind="phone_number",
        sender_id=identifier, operation="text.send", idempotency_key="same")
    assert result == identifier
    transport.post.assert_not_called()
    assert transport.get.call_args.kwargs["headers"] == {"Idempotency-Key": "same"}


def test_long_retry_after_returns_the_error_without_retrying(monkeypatch):
    sleep = MagicMock()
    monkeypatch.setattr("inkbox._message_requests.time.sleep", sleep)
    transport = MagicMock()
    error = InkboxAPIError(429, {"error": "rate_limited"})
    error.retry_after_seconds = 60
    transport.post.side_effect = error
    with pytest.raises(InkboxAPIError) as raised:
        post_message(transport, "/messages", json={}, idempotency_key="original")
    assert raised.value is error
    assert error.idempotency_key == "original"
    transport.post.assert_called_once()
    sleep.assert_not_called()
