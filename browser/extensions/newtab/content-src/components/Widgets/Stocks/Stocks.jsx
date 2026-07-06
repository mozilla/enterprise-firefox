/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// eslint-disable-next-line no-unused-vars
import React, { useCallback, useRef } from "react";
import { useSelector, batch } from "react-redux";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import { useIntersectionObserver, useSizeSubmenu } from "../../../lib/utils";
import { WIDGET_REGISTRY, resolveWidgetSize } from "common/WidgetsRegistry.mjs";
import { MoveSubmenu } from "../MoveSubmenu";

const USER_ACTION_TYPES = {
  CHANGE_SIZE: "change_size",
  SEARCH_TICKERS: "search_tickers",
  LEARN_MORE: "learn_more",
};

const STOCKS_ENTRY = WIDGET_REGISTRY.find(w => w.id === "stocks");

function Stocks({ dispatch, widgetsMayBeMaximized, widgetEnabledMap }) {
  const prefs = useSelector(state => state.Prefs.values);

  // Resolve size through the registry helper, not the pref, so trainhop and the
  // default can apply.
  const widgetSize = resolveWidgetSize(STOCKS_ENTRY, prefs);
  const impressionFired = useRef(false);

  const handleIntersection = useCallback(() => {
    if (impressionFired.current) {
      return;
    }
    impressionFired.current = true;
    dispatch(
      ac.AlsoToMain({
        type: at.WIDGETS_IMPRESSION,
        data: {
          widget_name: "stocks",
          widget_size: widgetSize,
        },
      })
    );
  }, [dispatch, widgetSize]);

  const widgetRef = useIntersectionObserver(handleIntersection);

  function handleStocksHide() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.SET_PREF,
          data: { name: STOCKS_ENTRY.enabledPref, value: false },
        })
      );
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_ENABLED,
          data: {
            widget_name: "stocks",
            widget_source: "context_menu",
            enabled: false,
            widget_size: widgetSize,
          },
        })
      );
    });
  }

  const handleChangeSize = useCallback(
    size => {
      batch(() => {
        dispatch(
          ac.OnlyToMain({
            type: at.SET_PREF,
            data: { name: STOCKS_ENTRY.sizePref, value: size },
          })
        );
        dispatch(
          ac.OnlyToMain({
            type: at.WIDGETS_USER_EVENT,
            data: {
              widget_name: "stocks",
              widget_source: "context_menu",
              user_action: USER_ACTION_TYPES.CHANGE_SIZE,
              action_value: size,
              widget_size: size,
            },
          })
        );
      });
    },
    [dispatch]
  );

  const sizeSubmenuRef = useSizeSubmenu(handleChangeSize);

  // Placeholder: a real ticker search will replace this telemetry-only stub in
  // a follow-up.
  function handleSearchTickers() {
    dispatch(
      ac.OnlyToMain({
        type: at.WIDGETS_USER_EVENT,
        data: {
          widget_name: "stocks",
          widget_source: "context_menu",
          user_action: USER_ACTION_TYPES.SEARCH_TICKERS,
          widget_size: widgetSize,
        },
      })
    );
  }

  function handleLearnMore() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.OPEN_LINK,
          data: {
            url: "https://support.mozilla.org/kb/firefox-new-tab-widgets",
          },
        })
      );
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: {
            widget_name: "stocks",
            widget_source: "context_menu",
            user_action: USER_ACTION_TYPES.LEARN_MORE,
            widget_size: widgetSize,
          },
        })
      );
    });
  }

  return (
    <article
      className={`stocks widget col-4 ${widgetSize}-widget`}
      ref={el => {
        widgetRef.current = [el];
      }}
    >
      <div className="stocks-title-wrapper">
        <div className="stocks-context-menu-wrapper">
          <moz-button
            className="stocks-context-menu-button"
            iconSrc="chrome://global/skin/icons/more.svg"
            menuId="stocks-context-menu"
            type="ghost"
          />
          <panel-list id="stocks-context-menu">
            <panel-item
              data-l10n-id="newtab-stocks-menu-search"
              onClick={handleSearchTickers}
            />
            <hr />
            {widgetsMayBeMaximized && (
              <panel-item submenu="stocks-size-submenu">
                <span data-l10n-id="newtab-widget-menu-change-size"></span>
                <panel-list
                  ref={sizeSubmenuRef}
                  slot="submenu"
                  id="stocks-size-submenu"
                >
                  {["small", "medium", "large"].map(size => (
                    <panel-item
                      key={size}
                      type="checkbox"
                      checked={widgetSize === size || undefined}
                      data-size={size}
                      data-l10n-id={`newtab-widget-size-${size}`}
                    />
                  ))}
                </panel-list>
              </panel-item>
            )}

            <MoveSubmenu
              widgetId="stocks"
              widgetEnabledMap={widgetEnabledMap}
            />

            <panel-item
              data-l10n-id="newtab-stocks-menu-hide"
              onClick={handleStocksHide}
            />
            <panel-item
              data-l10n-id="newtab-stocks-menu-learn-more"
              onClick={handleLearnMore}
            />
          </panel-list>
        </div>
      </div>

      <div className="stocks-body" />
    </article>
  );
}

export { Stocks };
