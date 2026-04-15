import { GlobalOverrider } from "test/unit/utils";
import { mount, shallow } from "enzyme";
import React from "react";
import { INITIAL_STATE, reducers } from "common/Reducers.sys.mjs";
import { combineReducers, createStore } from "redux";
import { Provider } from "react-redux";
import { Search } from "content-src/components/Search/Search";
import { Logo } from "content-src/components/Logo/Logo";
import { ExternalComponentWrapper } from "content-src/components/ExternalComponentWrapper/ExternalComponentWrapper";

// Wrap this around any component that uses useSelector,
// or any mount that uses a child that uses redux.
function WrapWithProvider({ children, state = INITIAL_STATE }) {
  let store = createStore(combineReducers(reducers), state);
  return <Provider store={store}>{children}</Provider>;
}

describe("<Search>", () => {
  let globals;
  let sandbox;
  beforeEach(() => {
    globals = new GlobalOverrider();
    sandbox = globals.sandbox;

    global.ContentSearchUIController.prototype = { search: sandbox.spy() };
  });
  afterEach(() => {
    globals.restore();
  });

  it("should render a Search element", () => {
    const wrapper = shallow(
      <WrapWithProvider>
        <Search />
      </WrapWithProvider>
    );
    assert.ok(wrapper.exists());
  });
  it("should not use a <form> element", () => {
    const wrapper = mount(
      <WrapWithProvider>
        <Search />
      </WrapWithProvider>
    );

    assert.equal(wrapper.find("form").length, 0);
  });
  it("should show our logo when the prop exists.", () => {
    const showLogoProps = { showLogo: true };
    const wrapper = mount(
      <WrapWithProvider>
        <Search {...showLogoProps} />
      </WrapWithProvider>
    );
    const logo_component = wrapper.find(Logo);
    assert.ok(logo_component.exists());
  });
  it("should not show our logo when the prop does not exist.", () => {
    const hideLogoProps = { showLogo: false };
    const wrapper = mount(
      <WrapWithProvider>
        <Search {...hideLogoProps} />
      </WrapWithProvider>
    );
    const logo_component = wrapper.find(Logo);
    assert.ok(!logo_component.exists());
  });

  describe("Search Hand-off", () => {
    it("should render a Search hand-off element", () => {
      const wrapper = mount(
        <WrapWithProvider>
          <Search />
        </WrapWithProvider>
      );
      assert.ok(wrapper.exists());
      const externalComponentWrapper = wrapper.find(ExternalComponentWrapper);
      assert.equal(externalComponentWrapper.length, 1);
      assert.equal(externalComponentWrapper.prop("type"), "SEARCH");
    });
  });
});
