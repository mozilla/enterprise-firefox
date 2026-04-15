import pytest

URL = "https://lite.airtelkenya.com/"
UNSUPPORTED_TEXT = "Browser not supported"
SUPPORTED_CSS = "#login-heading"


async def visit_site(client):
    await client.navigate(URL, wait="none")


@pytest.mark.only_platforms("android")
@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    await visit_site(client)
    assert client.await_css(SUPPORTED_CSS, is_displayed=True)
    assert not client.find_text(UNSUPPORTED_TEXT, is_displayed=True)


@pytest.mark.only_platforms("android")
@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    await visit_site(client)
    assert client.await_text(UNSUPPORTED_TEXT, is_displayed=True)
    assert not client.find_text(SUPPORTED_CSS, is_displayed=True)
