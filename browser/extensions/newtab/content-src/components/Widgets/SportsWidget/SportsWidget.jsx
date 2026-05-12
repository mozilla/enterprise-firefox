/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// eslint-disable-next-line no-unused-vars
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSelector, batch } from "react-redux";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import { useIntersectionObserver } from "../../../lib/utils";

const WIDGET_STATES = {
  INTRO: "sports-intro",
  FOLLOW_TEAMS: "sports-follow-state",
};

const COUNTRIES = [
  { id: "CA", name: "Canada" },
  { id: "AU", name: "Australia" },
  { id: "DZ", name: "Algeria" },
  { id: "IQ", name: "Iraq" },
  { id: "IT", name: "Italy" },
  { id: "ES", name: "Spain" },
  { id: "NG", name: "Nigeria" },
  { id: "MR", name: "Morocco" },
  { id: "PT", name: "Portugal" },
  { id: "DE", name: "Germany" },
  { id: "SN", name: "Senegal" },
];

const USER_ACTION_TYPES = {
  FOLLOW_TEAMS: "follow_teams",
  VIEW_UPCOMING: "view_upcoming",
  VIEW_RESULTS: "view_results",
  VIEW_SCHEDULE: "view_schedule",
  CHANGE_SIZE: "change_size",
  LEARN_MORE: "learn_more",
};

const PREF_NOVA_ENABLED = "nova.enabled";
const PREF_SPORTS_WIDGET_SIZE = "widgets.sportsWidget.size";
const PREF_SPORTS_WIDGET_LIVE_ENABLED = "widgets.sportsWidget.live.enabled";

function SportsWidget({ dispatch, handleUserInteraction }) {
  const prefs = useSelector(state => state.Prefs.values);
  const sportsWidgetData = useSelector(state => state.SportsWidget);

  const widgetSize = prefs[PREF_SPORTS_WIDGET_SIZE] || "medium";
  const liveEnabled = prefs[PREF_SPORTS_WIDGET_LIVE_ENABLED];
  const widgetsMayBeMaximized = prefs["widgets.system.maximized"];
  const widgetState = sportsWidgetData.widgetState || WIDGET_STATES.INTRO;
  const displaySize =
    widgetState === WIDGET_STATES.FOLLOW_TEAMS ? "large" : widgetSize;
  const selectedTeams = sportsWidgetData.selectedTeams || [];
  const impressionFired = useRef(false);
  const sizeSubmenuRef = useRef(null);

  const handleIntersection = useCallback(() => {
    if (impressionFired.current) {
      return;
    }
    impressionFired.current = true;
    dispatch(
      ac.AlsoToMain({
        type: at.WIDGETS_IMPRESSION,
        data: {
          widget_name: "sports_widget",
          widget_size: widgetSize,
        },
      })
    );
  }, [dispatch, widgetSize]);

  const widgetRef = useIntersectionObserver(handleIntersection);

  const handleInteraction = useCallback(
    () => handleUserInteraction("sportsWidget"),
    [handleUserInteraction]
  );

  function handleFollowTeams(widgetSource) {
    dispatch(
      ac.OnlyToMain({
        type: at.WIDGETS_USER_EVENT,
        data: {
          widget_name: "sports_widget",
          widget_source: widgetSource,
          user_action: USER_ACTION_TYPES.FOLLOW_TEAMS,
          widget_size: widgetSize,
        },
      })
    );
    // Tell the backend the widget state changed — it will save it and update the UI.
    dispatch(
      ac.AlsoToMain({
        type: at.WIDGETS_SPORTS_CHANGE_WIDGET_STATE,
        data: WIDGET_STATES.FOLLOW_TEAMS,
      })
    );
    handleInteraction();
  }

  function handleViewUpcoming() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            user_action: USER_ACTION_TYPES.VIEW_UPCOMING,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  function handleViewResults() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            user_action: USER_ACTION_TYPES.VIEW_RESULTS,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  function handleSportsWidgetHide() {
    batch(() => {
      dispatch(
        ac.OnlyToMain({
          type: at.SET_PREF,
          data: { name: "widgets.sportsWidget.enabled", value: false },
        })
      );
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_ENABLED,
          data: {
            widget_name: "sports_widget",
            widget_source: "context_menu",
            enabled: false,
            widget_size: widgetSize,
          },
        })
      );
    });
    handleInteraction();
  }

  const handleChangeSize = useCallback(
    size => {
      batch(() => {
        dispatch(
          ac.OnlyToMain({
            type: at.SET_PREF,
            data: { name: PREF_SPORTS_WIDGET_SIZE, value: size },
          })
        );
        dispatch(
          ac.OnlyToMain({
            type: at.WIDGETS_USER_EVENT,
            data: {
              widget_name: "sports_widget",
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

  useEffect(() => {
    const el = sizeSubmenuRef.current;
    if (!el) {
      return undefined;
    }
    const listener = e => {
      const item = e.composedPath().find(node => node.dataset?.size);
      if (item) {
        handleChangeSize(item.dataset.size);
      }
    };
    el.addEventListener("click", listener);
    return () => el.removeEventListener("click", listener);
  }, [handleChangeSize]);

  function handleViewSchedule() {
    dispatch(
      ac.OnlyToMain({
        type: at.WIDGETS_USER_EVENT,
        data: {
          widget_name: "sports_widget",
          widget_source: "widget",
          user_action: USER_ACTION_TYPES.VIEW_SCHEDULE,
          widget_size: widgetSize,
        },
      })
    );
    handleInteraction();
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
      const telemetryData = {
        widget_name: "sports_widget",
        widget_source: "context_menu",
        user_action: USER_ACTION_TYPES.LEARN_MORE,
        widget_size: widgetSize,
      };
      dispatch(
        ac.OnlyToMain({
          type: at.WIDGETS_USER_EVENT,
          data: telemetryData,
        })
      );
    });
  }

  // Discard any team changes and go back to the intro state.
  const handleCancelSelection = useCallback(
    () =>
      dispatch(
        ac.AlsoToMain({
          type: at.WIDGETS_SPORTS_CHANGE_WIDGET_STATE,
          data: WIDGET_STATES.INTRO,
        })
      ),
    [dispatch]
  );

  // @nova-cleanup(remove-gate): Remove this guard and PREF_NOVA_ENABLED after Nova ships
  if (!prefs[PREF_NOVA_ENABLED]) {
    return null;
  }

  return (
    <article
      className={`sports widget col-4 ${displaySize}-widget ${widgetState}`}
      ref={el => {
        widgetRef.current = [el];
      }}
    >
      <div className="sports-title-wrapper">
        {/* The empty self-closing div here is used to help center the title, since the context menu also takes up space. */}
        {widgetState === WIDGET_STATES.INTRO && <div />}
        {widgetState === WIDGET_STATES.FOLLOW_TEAMS && (
          <span
            className="sports-follow-teams-title"
            data-l10n-id="newtab-sports-widget-follow-teams-title"
            // If changing this number, also update isMaxSelected in SportsWidgetFollowTeams.
            data-l10n-args={JSON.stringify({ number: 3 })}
          />
        )}
        {widgetState === WIDGET_STATES.INTRO && (
          <div className="sports-intro-wrapper">
            <h2
              className="sports-intro-title"
              data-l10n-id="newtab-sports-widget-keep-tabs"
            />
            <p
              className="sports-intro-lede"
              data-l10n-id="newtab-sports-widget-get-updates"
            ></p>
          </div>
        )}
        {widgetState === WIDGET_STATES.FOLLOW_TEAMS ? (
          <button
            className="sports-cancel-button"
            data-l10n-id="newtab-sports-widget-cancel"
            onClick={handleCancelSelection}
          />
        ) : (
          <div className="sports-context-menu-wrapper">
            <moz-button
              className="sports-context-menu-button"
              iconSrc="chrome://global/skin/icons/more.svg"
              menuId="sports-context-menu"
              type="ghost"
            />
            <panel-list id="sports-context-menu">
              <panel-item
                data-l10n-id="newtab-sports-widget-menu-follow-teams"
                onClick={() => handleFollowTeams("context_menu")}
              />
              <panel-item
                data-l10n-id="newtab-sports-widget-menu-view-upcoming"
                onClick={handleViewUpcoming}
              />
              <panel-item
                data-l10n-id="newtab-sports-widget-menu-view-results"
                onClick={handleViewResults}
              />
              {widgetsMayBeMaximized && (
                <panel-item submenu="sports-size-submenu">
                  <span data-l10n-id="newtab-widget-menu-change-size"></span>
                  <panel-list
                    ref={sizeSubmenuRef}
                    slot="submenu"
                    id="sports-size-submenu"
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
              <panel-item
                data-l10n-id="newtab-widget-menu-hide"
                onClick={handleSportsWidgetHide}
              />
              <panel-item
                data-l10n-id="newtab-sports-widget-menu-learn-more"
                onClick={handleLearnMore}
              />
            </panel-list>
          </div>
        )}
      </div>

      <div className="sports-body">
        {widgetState === WIDGET_STATES.FOLLOW_TEAMS ? (
          <SportsWidgetFollowTeams
            initialSelectedTeams={selectedTeams}
            dispatch={dispatch}
            onClose={handleCancelSelection}
          />
        ) : (
          <>
            <div className="sports-buttons-wrapper">
              <moz-button
                type="primary"
                size={widgetSize === "medium" ? "small" : undefined}
                data-l10n-id="newtab-sports-widget-view-matches"
                className="sports-view-matches"
                onClick={handleViewSchedule}
              />
              <moz-button
                type="secondary"
                size={widgetSize === "medium" ? "small" : undefined}
                data-l10n-id="newtab-sports-widget-follow-teams"
                className="sports-follow-teams-btn"
                onClick={() => handleFollowTeams("widget")}
              />
            </div>
            {liveEnabled && sportsWidgetData?.initialized && (
              <div className="sports-live-scores">
                {/* Live scores content */}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function SportsWidgetFollowTeams({ onClose, initialSelectedTeams, dispatch }) {
  const [selectedTeams, setSelectedTeams] = useState(initialSelectedTeams);
  const [searchQuery, setSearchQuery] = useState("");
  const isMaxSelected = selectedTeams.length >= 3;

  const filteredCountries = searchQuery
    ? COUNTRIES.filter(c =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : COUNTRIES;

  function handleCountryToggle(countryId, isChecked) {
    setSelectedTeams(prev =>
      isChecked ? [...prev, countryId] : prev.filter(id => id !== countryId)
    );
  }

  // Save the selected teams and go back to the intro state.
  function handleDoneSelection() {
    dispatch(
      ac.AlsoToMain({
        type: at.WIDGETS_SPORTS_CHANGE_SELECTED_TEAMS,
        data: selectedTeams,
      })
    );
    onClose();
  }

  return (
    <div className="sports-follow-teams">
      <moz-input-search
        data-l10n-id="newtab-sports-widget-search-country"
        className="sports-country-search"
        onInput={e => setSearchQuery(e.target.value)}
      />
      <div className="sports-follow-teams-list">
        {filteredCountries.map(country => {
          const isSelected = selectedTeams.includes(country.id);
          return (
            <moz-checkbox
              key={country.id}
              label={country.name}
              checked={isSelected || undefined}
              disabled={!isSelected && isMaxSelected ? true : undefined}
              onChange={e => handleCountryToggle(country.id, e.target.checked)}
            />
          );
        })}
      </div>
      <moz-button
        className="sports-done-button"
        data-l10n-id="newtab-sports-widget-done-button"
        type="primary"
        size="small"
        onClick={handleDoneSelection}
      />
    </div>
  );
}

export { SportsWidget };
