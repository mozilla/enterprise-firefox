/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { render, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { combineReducers, createStore } from "redux";
import { INITIAL_STATE, reducers } from "common/Reducers.sys.mjs";
import { actionTypes as at } from "common/Actions.mjs";
import { Crossword } from "content-src/components/Widgets/Crossword/Crossword";

const baseState = {
  ...INITIAL_STATE,
  Prefs: {
    ...INITIAL_STATE.Prefs,
    values: {
      ...INITIAL_STATE.Prefs.values,
      "widgets.system.enabled": true,
      "widgets.enabled": true,
      "widgets.system.crossword.enabled": true,
      "widgets.crossword.enabled": true,
      "widgets.crossword.size": "",
    },
  },
};

function WrapWithProvider({ children, state = baseState }) {
  const store = createStore(combineReducers(reducers), state);
  return <Provider store={store}>{children}</Provider>;
}

function renderCrossword({
  state = baseState,
  dispatch = jest.fn(),
  widgetsMayBeMaximized = true,
} = {}) {
  const widgetEnabledMap = { crossword: true };
  const utils = render(
    <WrapWithProvider state={state}>
      <Crossword
        dispatch={dispatch}
        widgetsMayBeMaximized={widgetsMayBeMaximized}
        widgetEnabledMap={widgetEnabledMap}
      />
    </WrapWithProvider>
  );
  return { ...utils, dispatch };
}

describe("<Crossword>", () => {
  describe("rendering", () => {
    it("renders the article root with the default medium size class", () => {
      const { container } = renderCrossword();
      const root = container.querySelector("article.crossword");
      expect(root).toBeInTheDocument();
      expect(root).toHaveClass("widget");
      expect(root).toHaveClass("col-4");
      expect(root).toHaveClass("medium-widget");
    });

    it("applies the size from the size pref when set", () => {
      const state = {
        ...baseState,
        Prefs: {
          ...baseState.Prefs,
          values: {
            ...baseState.Prefs.values,
            "widgets.crossword.size": "large",
          },
        },
      };
      const { container } = renderCrossword({ state });
      expect(container.querySelector("article.crossword")).toHaveClass(
        "large-widget"
      );
    });

    it("renders the size submenu only when widgetsMayBeMaximized", () => {
      const { container, rerender } = renderCrossword({
        widgetsMayBeMaximized: true,
      });
      expect(
        container.querySelector("#crossword-size-submenu")
      ).toBeInTheDocument();

      rerender(
        <WrapWithProvider state={baseState}>
          <Crossword
            dispatch={jest.fn()}
            widgetsMayBeMaximized={false}
            widgetEnabledMap={{ crossword: true }}
          />
        </WrapWithProvider>
      );
      expect(
        container.querySelector("#crossword-size-submenu")
      ).not.toBeInTheDocument();
    });
  });

  describe("hide action", () => {
    it("dispatches SET_PREF and WIDGETS_ENABLED when hide is clicked", () => {
      const { container, dispatch } = renderCrossword();
      const hideItem = container.querySelector(
        "panel-item[data-l10n-id='newtab-widget-menu-hide']"
      );
      fireEvent.click(hideItem);

      const setPrefCall = dispatch.mock.calls.find(
        ([action]) =>
          action?.type === at.SET_PREF &&
          action.data?.name === "widgets.crossword.enabled"
      );
      expect(setPrefCall?.[0].data.value).toBe(false);

      const enabledCall = dispatch.mock.calls.find(
        ([action]) => action?.type === at.WIDGETS_ENABLED
      );
      expect(enabledCall?.[0].data).toMatchObject({
        widget_name: "crossword",
        widget_source: "context_menu",
        enabled: false,
      });
    });
  });

  describe("learn more action", () => {
    it("dispatches OPEN_LINK with the shared SUMO URL", () => {
      const { container, dispatch } = renderCrossword();
      const learnMoreItem = container.querySelector("panel-item.learn-more");
      fireEvent.click(learnMoreItem);

      const openLinkCall = dispatch.mock.calls.find(
        ([action]) => action?.type === at.OPEN_LINK
      );
      expect(openLinkCall?.[0].data.url).toBe(
        "https://support.mozilla.org/kb/firefox-new-tab-widgets"
      );
    });

    it("dispatches a learn_more WIDGETS_USER_EVENT", () => {
      const { container, dispatch } = renderCrossword();
      fireEvent.click(container.querySelector("panel-item.learn-more"));

      const userEventCall = dispatch.mock.calls.find(
        ([action]) =>
          action?.type === at.WIDGETS_USER_EVENT &&
          action.data?.user_action === "learn_more"
      );
      expect(userEventCall?.[0].data).toMatchObject({
        widget_name: "crossword",
        widget_source: "context_menu",
        user_action: "learn_more",
        widget_size: "medium",
      });
    });
  });

  describe("impression telemetry", () => {
    let originalIntersectionObserver;
    let observerInstances;

    beforeEach(() => {
      observerInstances = [];
      originalIntersectionObserver = global.IntersectionObserver;
      global.IntersectionObserver = class MockIntersectionObserver {
        constructor(callback) {
          this.callback = callback;
          this.observed = [];
          observerInstances.push(this);
        }
        observe(el) {
          this.observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      };
    });

    afterEach(() => {
      global.IntersectionObserver = originalIntersectionObserver;
    });

    it("dispatches WIDGETS_IMPRESSION only once even when intersection fires repeatedly", () => {
      const { dispatch } = renderCrossword();
      const [observer] = observerInstances;
      const [target] = observer.observed;

      observer.callback([{ isIntersecting: true, target }], observer);
      observer.callback([{ isIntersecting: true, target }], observer);

      const impressions = dispatch.mock.calls.filter(
        ([action]) => action?.type === at.WIDGETS_IMPRESSION
      );
      expect(impressions).toHaveLength(1);
      expect(impressions[0][0].data).toMatchObject({
        widget_name: "crossword",
        widget_size: "medium",
      });
    });
  });

  describe("change size action", () => {
    it("dispatches SET_PREF and a change_size WIDGETS_USER_EVENT when a size is picked", () => {
      const { container, dispatch } = renderCrossword();
      const largeSizeItem = container.querySelector(
        "#crossword-size-submenu panel-item[data-size='large']"
      );
      fireEvent.click(largeSizeItem);

      const setPrefCall = dispatch.mock.calls.find(
        ([action]) =>
          action?.type === at.SET_PREF &&
          action.data?.name === "widgets.crossword.size"
      );
      expect(setPrefCall?.[0].data.value).toBe("large");

      const userEventCall = dispatch.mock.calls.find(
        ([action]) =>
          action?.type === at.WIDGETS_USER_EVENT &&
          action.data?.user_action === "change_size"
      );
      expect(userEventCall?.[0].data).toMatchObject({
        widget_name: "crossword",
        widget_source: "context_menu",
        user_action: "change_size",
        action_value: "large",
        widget_size: "large",
      });
    });
  });
});
