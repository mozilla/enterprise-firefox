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
};

const CROSSWORD_ENTRY = WIDGET_REGISTRY.find(w => w.id === "crossword");

function Crossword({ dispatch, widgetsMayBeMaximized, widgetEnabledMap }) {
  const prefs = useSelector(state => state.Prefs.values);
  const widgetSize = resolveWidgetSize(CROSSWORD_ENTRY, prefs);
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
          widget_name: "crossword",
          widget_size: widgetSize,
        },
      })
    );
  }, [dispatch, widgetSize]);

  const widgetRef = useIntersectionObserver(handleIntersection);

  function handleCrosswordHide() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.SET_PREF,
          data: { name: CROSSWORD_ENTRY.enabledPref, value: false },
        })
      );
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_ENABLED,
          data: {
            widget_name: "crossword",
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
            data: { name: CROSSWORD_ENTRY.sizePref, value: size },
          })
        );
        dispatch(
          ac.OnlyToMain({
            type: at.WIDGETS_USER_EVENT,
            data: {
              widget_name: "crossword",
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
            widget_name: "crossword",
            widget_source: "context_menu",
            user_action: "learn_more",
            widget_size: widgetSize,
          },
        })
      );
    });
  }

  return (
    <article
      className={`crossword widget col-4 ${widgetSize}-widget`}
      ref={el => {
        widgetRef.current = [el];
      }}
    >
      <div className="crossword-title-wrapper">
        <h3 className="newtab-crossword-title"></h3>
        <div className="crossword-context-menu-wrapper">
          <moz-button
            className="crossword-context-menu-button"
            iconSrc="chrome://global/skin/icons/more.svg"
            menuId="crossword-context-menu"
            type="ghost"
          />
          <panel-list id="crossword-context-menu">
            {widgetsMayBeMaximized && (
              <panel-item submenu="crossword-size-submenu">
                <span data-l10n-id="newtab-widget-menu-change-size"></span>
                <panel-list
                  ref={sizeSubmenuRef}
                  slot="submenu"
                  id="crossword-size-submenu"
                >
                  {["medium", "large"].map(size => (
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
              widgetId="crossword"
              widgetEnabledMap={widgetEnabledMap}
            />

            <panel-item
              data-l10n-id="newtab-widget-menu-hide"
              onClick={handleCrosswordHide}
            />
            {/* TODO: Add in fluent string when correct preview files are set up */}
            <panel-item className="learn-more" onClick={handleLearnMore}>
              Learn more
            </panel-item>
          </panel-list>
        </div>
      </div>

      <div className="crossword-body"></div>
    </article>
  );
}

export { Crossword };
