# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import os
import threading
import time
import urllib.parse
import urllib.request

import mozunit
import pytest
from tryselect.util.taskcluster import (
    TC_ROOT_URL,
    _scopes_key,
    get_client,
)

import taskcluster as tc_module

DEFAULT_SCOPES = ["some:scope"]
BROWSER_CLIENT_ID = "browser-client"
BROWSER_ACCESS_TOKEN = "browser-token"


@pytest.fixture
def credentials_file(tmp_path, monkeypatch):
    creds_path = tmp_path / "tc_credentials.json"
    monkeypatch.setattr(
        "tryselect.util.taskcluster._get_credentials_file", lambda: creds_path
    )
    return creds_path


def make_cache(credentials_file, scopes=None, expires_offset=7200):
    scopes = scopes or DEFAULT_SCOPES
    credentials_file.write_text(
        json.dumps({
            _scopes_key(scopes): {
                "clientId": "cached-client",
                "accessToken": "cached-token",
                "expires": time.time() + expires_offset,
            }
        })
    )


@pytest.fixture
def run_get_client(monkeypatch):

    def fake_webbrowser_open(url):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        callback_url = params["callback_url"][0]
        qs = urllib.parse.urlencode({
            "clientId": BROWSER_CLIENT_ID,
            "accessToken": BROWSER_ACCESS_TOKEN,
        })

        def send_creds():
            try:
                urllib.request.urlopen(f"{callback_url}?{qs}", timeout=10)
            except Exception:
                pass

        threading.Thread(target=send_creds, daemon=True).start()

    def inner(service="queue", scopes=None, env=None):
        scopes = scopes or DEFAULT_SCOPES
        env = env or {}
        monkeypatch.setattr(os, "environ", env)
        monkeypatch.setattr("webbrowser.open", fake_webbrowser_open)
        return get_client(service, scopes)

    return inner


def test_get_client_automation(run_get_client):
    result = run_get_client(
        env={
            "MOZ_AUTOMATION": "1",
            "TASKCLUSTER_CLIENT_ID": "env-client",
            "TASKCLUSTER_ACCESS_TOKEN": "env-token",
            "TASKCLUSTER_ROOT_URL": "https://tc.example.com",
        },
    )
    assert isinstance(result, tc_module.Queue)
    assert result.options["credentials"]["clientId"] == b"env-client"
    assert result.options["credentials"]["accessToken"] == b"env-token"


def test_get_client_cache_hit(credentials_file, run_get_client):
    make_cache(credentials_file)
    result = run_get_client()
    assert isinstance(result, tc_module.Queue)
    assert result.options["rootUrl"] == TC_ROOT_URL
    assert result.options["credentials"]["clientId"] == b"cached-client"
    assert result.options["credentials"]["accessToken"] == b"cached-token"


def test_get_client_cache_expired(credentials_file, run_get_client):
    make_cache(credentials_file, expires_offset=200)
    result = run_get_client()
    assert isinstance(result, tc_module.Queue)
    assert result.options["rootUrl"] == TC_ROOT_URL
    assert result.options["credentials"]["clientId"] == b"browser-client"
    assert result.options["credentials"]["accessToken"] == b"browser-token"


def test_get_client_browser_auth(credentials_file, run_get_client):
    assert not credentials_file.exists()
    result = run_get_client()
    assert isinstance(result, tc_module.Queue)
    assert result.options["rootUrl"] == TC_ROOT_URL
    assert result.options["credentials"]["clientId"] == b"browser-client"
    assert result.options["credentials"]["accessToken"] == b"browser-token"
    assert credentials_file.is_file()


if __name__ == "__main__":
    mozunit.main()
