import pytest

URL = "https://www.ogcrush.ogcrush.com/product-category/accessories/"
BANNER_CSS = ".nm-banner-slide.slick-slide.slick-active"
BANNER_CONTENTS_CSS = ".nm-banner.content-boxed"


async def slick_slide_fits_content(client):
    await client.navigate(URL)

    banner = client.await_css(BANNER_CSS, is_displayed=True)
    await client.stall(2)

    return client.execute_script(
        """
        const [banner, contentsCSS] = arguments;
        const contents = banner.querySelector(contentsCSS);

        const bannerBox = banner.getBoundingClientRect();
        const contentsBox = contents.getBoundingClientRect();

        return bannerBox.bottom == contentsBox.bottom;
      """,
        banner,
        BANNER_CONTENTS_CSS,
    )


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    assert await slick_slide_fits_content(client)


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    assert not await slick_slide_fits_content(client)
