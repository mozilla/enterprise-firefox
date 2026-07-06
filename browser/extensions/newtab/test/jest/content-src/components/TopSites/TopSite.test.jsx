import { render } from "@testing-library/react";
import { WrapWithProvider } from "test/jest/test-utils";
import { TopSite, TopSiteLink } from "content-src/components/TopSites/TopSite";
import { buildTopSitesList } from "content-src/components/TopSites/TopSiteListContainer";

const DEFAULT_LINK = {
  url: "https://example.com",
  hostname: "example.com",
  title: "Example",
  label: "Example",
  iconType: "no_image",
};

describe("<TopSite>", () => {
  it("should render", () => {
    const { container } = render(
      <WrapWithProvider>
        <TopSite
          link={DEFAULT_LINK}
          index={0}
          dispatch={jest.fn()}
          onDragEvent={jest.fn()}
          activeIndex={-1}
        />
      </WrapWithProvider>
    );
    expect(container.querySelector(".top-site-outer")).toBeInTheDocument();
  });
});

describe("buildTopSitesList Add button placement", () => {
  function getSites(rows, { rowsCount = 1, perRow = 8 } = {}) {
    return buildTopSitesList(rows, rowsCount, perRow);
  }

  function addButtonIndex(sites) {
    return sites.findIndex(site => site?.isAddButton);
  }

  it("places the Add button in the first slot when there are no shortcuts", () => {
    expect(addButtonIndex(getSites([]))).toBe(0);
  });

  it("keeps the Add button visible after the first shortcut is added", () => {
    // Regression for Bug 2046956: starting from zero shortcuts and adding one
    // used to default the Add button to the last slot, where pinning the new
    // shortcut pushed the button out of bounds and hid it.
    expect(addButtonIndex(getSites([DEFAULT_LINK]))).toBe(1);
  });

  it("places the Add button right after the last shortcut", () => {
    expect(
      addButtonIndex(getSites([DEFAULT_LINK, DEFAULT_LINK, DEFAULT_LINK]))
    ).toBe(3);
  });
});

describe("TopSiteLink #_allowDrop with grouped pins", () => {
  const topsiteDrag = { dataTransfer: { types: ["text/topsite-index"] } };
  const makeLink = link => new TopSiteLink({ groupedPinsEnabled: true, link });

  it("allows dropping on a pinned tile", () => {
    expect(makeLink({ isPinned: true })._allowDrop(topsiteDrag)).toBe(true);
  });

  it("rejects dropping on a frecent (non-pinned) tile", () => {
    expect(makeLink({ isPinned: false })._allowDrop(topsiteDrag)).toBe(false);
  });

  it("stays rejected on a frecent tile even with a stale dragged flag", () => {
    // Regression: `dragged` is only reset on the next mousedown, so a cancelled
    // drag used to leave it true here and wrongly mark this slot droppable.
    const link = makeLink({ isPinned: false });
    link.dragged = true;
    expect(link._allowDrop(topsiteDrag)).toBe(false);
  });
});
