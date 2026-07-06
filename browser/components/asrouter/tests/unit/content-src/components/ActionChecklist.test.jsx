import React from "react";
import { mount, shallow } from "enzyme";
import {
  ActionChecklist,
  ActionChecklistItem,
  ActionChecklistProgressBar,
} from "content-src/components/ActionChecklist";
import { GlobalOverrider } from "tests/unit/utils";

describe("Action Checklist component", () => {
  let globals;

  describe("<ActionChecklist>", () => {
    let sandbox;
    const mockContent = {
      action_checklist_subtitle: {
        raw: "Test subtitle",
      },
      tiles: {
        data: [
          {
            type: "action_checklist",
            data: [
              {
                id: "action-checklist-test",
                targeting: "false",
                label: {
                  raw: "Test label",
                },
                action: {
                  data: {
                    pref: {
                      name: "messaging-system-action.test1",
                      value: "false",
                    },
                  },
                  type: "SET_PREF",
                },
              },
              {
                id: "action-checklist-test2",
                targeting: "false",
                label: {
                  raw: "Test label 2",
                },
                action: {
                  data: {
                    pref: {
                      name: "messaging-system-action.test2",
                      value: "false",
                    },
                  },
                  type: "SET_PREF",
                },
              },
            ],
          },
        ],
      },
    };

    beforeEach(async () => {
      sandbox = sinon.createSandbox();
      globals = new GlobalOverrider();
      globals.set({
        AWEvaluateAttributeTargeting: () => Promise.resolve(),
        AWSendEventTelemetry: () => {},
      });
    });

    afterEach(async () => {
      globals.restore();
      sandbox.restore();
    });

    it("should render", async () => {
      const wrapper = mount(<ActionChecklist content={mockContent} />);
      assert.ok(wrapper.exists());
    });

    it("should render a subtitle when the action_checklist_subtitle property is present", () => {
      const wrapper = mount(<ActionChecklist content={mockContent} />);
      let subtitle = wrapper.find(".action-checklist-subtitle");
      assert.ok(subtitle);
      assert.equal(subtitle.text(), mockContent.action_checklist_subtitle.raw);
    });

    it("should render a number of action checklist items equal to the number of items in its configuration", async () => {
      const wrapper = mount(<ActionChecklist content={mockContent} />);

      assert.equal(wrapper.children().length, mockContent.tiles.data.length);
      assert.ok(wrapper.exists());
    });
  });

  describe("<ActionChecklistItem>", () => {
    let sandbox;

    beforeEach(async () => {
      globals = new GlobalOverrider();
      globals.set({
        AWEvaluateAttributeTargeting: () => Promise.resolve(),
      });
      sandbox = sinon.createSandbox();
    });

    afterEach(async () => {
      globals.restore();
      sandbox.restore();
    });

    const mockItem = {
      id: "test-item",
      targeting: "true",
      label: {
        raw: "test",
      },
    };

    const handleAction = sinon.spy();

    it("should render with a button", async () => {
      const wrapper = shallow(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      assert.ok(wrapper.find("button").exists());
    });

    it("should render with a label", async () => {
      const wrapper = mount(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      assert.ok(wrapper.find("span").exists());
      assert.equal(wrapper.find("span").text(), mockItem.label.raw);
    });

    it("should call handleAction when clicked", async () => {
      const wrapper = shallow(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      await wrapper.find("button").simulate("click");
      assert.calledOnce(handleAction);
    });

    it("should display an action arrow when targeting is false", async () => {
      sandbox.stub(window, "AWEvaluateAttributeTargeting").resolves(false);
      const wrapper = mount(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      wrapper.update();
      assert.ok(wrapper.find(".action-arrow").exists());
    });

    it("should display a filled checkbox when targeting is true", async () => {
      sandbox.stub(window, "AWEvaluateAttributeTargeting").resolves(true);
      const wrapper = mount(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      wrapper.update();
      assert.ok(wrapper.find(".check-filled").exists());
    });

    it("should be disabled when targeting is true", async () => {
      sandbox.stub(window, "AWEvaluateAttributeTargeting").resolves(true);
      const wrapper = shallow(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      assert.ok(wrapper.find("button").prop("disabled"));
    });

    it("should be disabled when clicked", async () => {
      const wrapper = shallow(
        <ActionChecklistItem
          item={mockItem}
          index={0}
          handleAction={handleAction}
        />
      );
      await wrapper.find("button").simulate("click");
      assert.ok(wrapper.find("button").prop("disabled"));
    });
  });

  describe("<ActionChecklistProgressbar>", () => {
    it("should render the progress bar", async () => {
      const wrapper = shallow(<ActionChecklistProgressBar progress={0} />);
      assert.ok(wrapper.exists());
    });

    it("should render the progress bar indicator with a width based on the progress", async () => {
      const progressPercent = 25;
      const wrapper = shallow(
        <ActionChecklistProgressBar progress={progressPercent} />
      );
      const indicatorElement = wrapper.find(".indicator");
      const indicatorWidth =
        indicatorElement.prop("style")[
          "--action-checklist-progress-bar-progress"
        ];
      assert.equal(indicatorWidth, `${progressPercent}%`);
    });
  });
});
