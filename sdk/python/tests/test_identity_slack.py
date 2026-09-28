"""Identity Slack opt-in, omission, and reversible updates over the public client."""

import json
from pathlib import Path

import httpx
import pytest

from inkbox import Inkbox

IDENTITY = json.loads(
    (Path(__file__).parents[3] / "tests/fixtures/slack_identity.json").read_text()
)


@pytest.fixture
def wire():
    client = Inkbox(api_key="synthetic-test-key", base_url="https://example.com")
    requests = []

    def handle(request):
        requests.append(request)
        body = json.loads(request.content) if request.content else {}
        return httpx.Response(200, json={**IDENTITY, **body})

    client._ids_http._client.close()
    client._ids_http._client = httpx.Client(
        base_url="https://example.com/api/v1/identities/",
        transport=httpx.MockTransport(handle),
    )
    yield client, requests
    client.close()


def test_create_and_update_slack_preserve_default_and_false(wire):
    client, requests = wire
    identity = client.create_identity("support-agent")
    assert identity.slack_enabled is False
    assert "slack_enabled" not in json.loads(requests[-1].content)
    identity = client.create_identity("support-agent", slack_enabled=True)
    assert identity.slack_enabled is True
    assert json.loads(requests[-1].content)["slack_enabled"] is True
    identity.update(slack_enabled=False)
    assert identity.slack_enabled is False
    assert requests[-1].method == "PATCH"
    assert json.loads(requests[-1].content) == {"slack_enabled": False}
    identity.update(display_name="Support")
    assert "slack_enabled" not in json.loads(requests[-1].content)


@pytest.mark.parametrize("invalid", [None, "true", 1])
def test_slack_null_or_nonboolean_never_dispatches(wire, invalid):
    client, requests = wire
    with pytest.raises(ValueError, match="slack_enabled must be a boolean"):
        client.create_identity("support-agent", slack_enabled=invalid)
    assert requests == []
    identity = client.get_identity("support-agent")
    with pytest.raises(ValueError, match="slack_enabled must be a boolean"):
        identity.update(slack_enabled=invalid)
    assert len(requests) == 1
