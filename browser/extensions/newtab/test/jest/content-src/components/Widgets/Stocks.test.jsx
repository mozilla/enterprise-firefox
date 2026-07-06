/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { render, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { combineReducers, createStore } from "redux";
import { INITIAL_STATE, reducers } from "common/Reducers.sys.mjs";
import { actionTypes as at } from "common/Actions.mjs";
import { Stocks } from "content-src/components/Widgets/Stocks/Stocks";

const mockState = {
  ...INITIAL_STATE,
  Prefs: {
    ...INITIAL_STATE.Prefs,
    values: {
      ...INITIAL_STATE.Prefs.values,
      "widgets.system.enabled": true,
      "widgets.system.stocks.enabled": true,
      "widgets.stocks.enabled": true,
      "widgets.stocks.size": "medium",
    },
  },
};

function WrapWithProvider({ children, state = INITIAL_STATE }) {
  const store = createStore(combineReducers(reducers), state);
  return <Provider store={store}>{children}</Provider>;
}

function renderStocks(dispatch = jest.fn(), props = {}) {
  const { container, unmount } = render(
    <WrapWithProvider state={mockState}>
      <Stocks
        dispatch={dispatch}
        widgetsMayBeMaximized={true}
        widgetEnabledMap={{}}
        {...props}
      />
    </WrapWithProvider>
  );
  return { container, unmount, dispatch };
}

describe("Stocks widget", () => {
  it("renders the widget at the resolved size", () => {
    const { container } = renderStocks();
    const root = container.querySelector("article.stocks");
    expect(root).toBeTruthy();
    expect(root.className).toContain("medium-widget");
  });

  it("renders the size submenu with all three sizes", () => {
    const { container } = renderStocks();
    const sizes = [...container.querySelectorAll("[data-size]")].map(el =>
      el.getAttribute("data-size")
    );
    expect(sizes).toEqual(["small", "medium", "large"]);
  });

  it("hides the widget by setting its enabled pref to false", () => {
    const dispatch = jest.fn();
    const { container } = renderStocks(dispatch);
    const hide = container.querySelector(
      '[data-l10n-id="newtab-stocks-menu-hide"]'
    );
    fireEvent.click(hide);
    const setPref = dispatch.mock.calls.find(
      ([action]) =>
        action.type === at.SET_PREF &&
        action.data?.name === "widgets.stocks.enabled"
    );
    expect(setPref).toBeTruthy();
    expect(setPref[0].data.value).toBe(false);
  });

  it("records a telemetry event for the ticker-search stub", () => {
    const dispatch = jest.fn();
    const { container } = renderStocks(dispatch);
    const search = container.querySelector(
      '[data-l10n-id="newtab-stocks-menu-search"]'
    );
    fireEvent.click(search);
    const evt = dispatch.mock.calls.find(
      ([action]) =>
        action.type === at.WIDGETS_USER_EVENT &&
        action.data?.user_action === "search_tickers"
    );
    expect(evt).toBeTruthy();
  });
});
