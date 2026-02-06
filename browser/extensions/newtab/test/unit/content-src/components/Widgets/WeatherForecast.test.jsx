import React from "react";
import { combineReducers, createStore } from "redux";
import { Provider } from "react-redux";
import { mount } from "enzyme";
import { INITIAL_STATE, reducers } from "common/Reducers.sys.mjs";
import { actionTypes as at } from "common/Actions.mjs";
import { WeatherForecast } from "content-src/components/Widgets/WeatherForecast/WeatherForecast";

const weatherSuggestion = {
  current_conditions: {
    icon_id: 3,
    summary: "Partly Cloudy",
    temperature: {
      c: 20,
      f: 68,
    },
  },
  forecast: {
    high: {
      c: 25,
      f: 77,
    },
    low: {
      c: 15,
      f: 59,
    },
  },
};

const mockState = {
  ...INITIAL_STATE,
  Prefs: {
    ...INITIAL_STATE.Prefs,
    values: {
      ...INITIAL_STATE.Prefs.values,
      showWeather: true,
      "system.showWeather": true,
      "weather.display": "detailed",
      "weather.temperatureUnits": "f",
      "weather.locationSearchEnabled": true,
      "system.showWeatherOptIn": true,
      "widgets.system.weatherForecast.enabled": true,
    },
  },
  Weather: {
    initialized: true,
    searchActive: false,
    locationData: {
      city: "Testville",
    },
    suggestions: [weatherSuggestion],
  },
};

function WrapWithProvider({ children, state = INITIAL_STATE }) {
  let store = createStore(combineReducers(reducers), state);
  return <Provider store={store}>{children}</Provider>;
}

describe("<WeatherForecast>", () => {
  let wrapper;
  let sandbox;
  let dispatch;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    dispatch = sandbox.stub();

    wrapper = mount(
      <WrapWithProvider state={mockState}>
        <WeatherForecast dispatch={dispatch} />
      </WrapWithProvider>
    );
  });

  afterEach(() => {
    sandbox.restore();
    wrapper?.unmount();
  });

  it("should render weather forecast widget", () => {
    assert.ok(wrapper.exists());
    assert.ok(wrapper.find(".weather-forecast-widget").exists());
  });

  it("should not render when detailed view is disabled", () => {
    const simpleViewState = {
      ...mockState,
      Prefs: {
        ...mockState.Prefs,
        values: {
          ...mockState.Prefs.values,
          "weather.display": "simple",
        },
      },
    };

    wrapper = mount(
      <WrapWithProvider state={simpleViewState}>
        <WeatherForecast dispatch={dispatch} />
      </WrapWithProvider>
    );

    assert.ok(!wrapper.find(".weather-forecast-widget").exists());
  });

  it("should not render when weather is disabled", () => {
    const weatherDisabledState = {
      ...mockState,
      Prefs: {
        ...mockState.Prefs,
        values: {
          ...mockState.Prefs.values,
          showWeather: false,
        },
      },
    };

    wrapper = mount(
      <WrapWithProvider state={weatherDisabledState}>
        <WeatherForecast dispatch={dispatch} />
      </WrapWithProvider>
    );

    assert.ok(!wrapper.find(".weather-forecast-widget").exists());
  });

  it("should display city name when search is inactive", () => {
    const cityName = wrapper.find(".city-name h3");
    assert.ok(cityName.exists());
    assert.equal(cityName.text(), "Testville");
  });

  it("should display LocationSearch component when search is active", () => {
    const searchActiveState = {
      ...mockState,
      Weather: {
        ...mockState.Weather,
        searchActive: true,
      },
    };

    wrapper = mount(
      <WrapWithProvider state={searchActiveState}>
        <WeatherForecast dispatch={dispatch} />
      </WrapWithProvider>
    );

    assert.ok(wrapper.find("LocationSearch").exists());
    assert.ok(!wrapper.find(".city-name h3").exists());
  });

  describe("context menu", () => {
    it("should render context menu with correct panel items", () => {
      assert.ok(wrapper.find(".weather-forecast-context-menu-button").exists());
      assert.ok(wrapper.find("#weather-forecast-context-menu").exists());

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-change-location']"
          )
          .exists()
      );

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-detect-my-location']"
          )
          .exists()
      );

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-change-temperature-units-celsius']"
          )
          .exists()
      );

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-change-weather-display-simple']"
          )
          .exists()
      );

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-hide-weather-v2']"
          )
          .exists()
      );

      assert.ok(
        wrapper
          .find("panel-item[data-l10n-id='newtab-weather-menu-learn-more']")
          .exists()
      );
    });

    it("should not show 'Detect my location' when opt-in is disabled", () => {
      const noOptInState = {
        ...mockState,
        Prefs: {
          ...mockState.Prefs,
          values: {
            ...mockState.Prefs.values,
            "system.showWeatherOptIn": false,
          },
        },
      };

      wrapper = mount(
        <WrapWithProvider state={noOptInState}>
          <WeatherForecast dispatch={dispatch} />
        </WrapWithProvider>
      );

      assert.isFalse(
        wrapper.contains(
          "panel-item[data-l10n-id='newtab-weather-menu-detect-my-location']"
        )
      );
    });

    it("should show 'Change to Fahrenheit' when temperature unit is Celsius", () => {
      const celsiusState = {
        ...mockState,
        Prefs: {
          ...mockState.Prefs,
          values: {
            ...mockState.Prefs.values,
            "weather.temperatureUnits": "c",
          },
        },
      };

      wrapper = mount(
        <WrapWithProvider state={celsiusState}>
          <WeatherForecast dispatch={dispatch} />
        </WrapWithProvider>
      );

      assert.ok(
        wrapper
          .find(
            "panel-item[data-l10n-id='newtab-weather-menu-change-temperature-units-fahrenheit']"
          )
          .exists()
      );
    });

    it("should dispatch WEATHER_SEARCH_ACTIVE when 'Change location' is clicked", () => {
      const changeLocationItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-change-location']"
      );
      changeLocationItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.WEATHER_SEARCH_ACTIVE);
      assert.equal(action.data, true);
    });

    it("should dispatch WEATHER_USER_OPT_IN_LOCATION when 'Detect my location' is clicked", () => {
      const detectLocationItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-detect-my-location']"
      );
      detectLocationItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.WEATHER_USER_OPT_IN_LOCATION);
    });

    it("should dispatch SET_PREF to change temperature units to Celsius", () => {
      const changeTempItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-change-temperature-units-celsius']"
      );
      changeTempItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.SET_PREF);
      assert.equal(action.data.name, "weather.temperatureUnits");
      assert.equal(action.data.value, "c");
    });

    it("should dispatch SET_PREF to change display to simple", () => {
      const changeDisplayItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-change-weather-display-simple']"
      );
      changeDisplayItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.SET_PREF);
      assert.equal(action.data.name, "weather.display");
      assert.equal(action.data.value, "simple");
    });

    it("should dispatch SET_PREF to hide weather when 'Hide weather' is clicked", () => {
      const hideWeatherItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-hide-weather-v2']"
      );
      hideWeatherItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.SET_PREF);
      assert.equal(action.data.name, "showWeather");
      assert.equal(action.data.value, false);
    });

    it("should dispatch OPEN_LINK when 'Learn more' is clicked", () => {
      const learnMoreItem = wrapper.find(
        "panel-item[data-l10n-id='newtab-weather-menu-learn-more']"
      );
      learnMoreItem.props().onClick();

      assert.ok(dispatch.calledOnce);
      const [action] = dispatch.getCall(0).args;
      assert.equal(action.type, at.OPEN_LINK);
      assert.equal(
        action.data.url,
        "https://support.mozilla.org/kb/firefox-new-tab-widgets"
      );
    });
  });
});
