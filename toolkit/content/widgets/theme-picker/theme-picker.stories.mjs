/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "../vendor/lit.all.mjs";
import "./theme-picker.mjs";

export default {
  title: "UI Widgets/Theme Picker",
  component: "theme-picker",
  argTypes: {
    variant: {
      options: ["default", "other"],
      control: { type: "select" },
    },
  },
};

const Template = ({ variant }) => html`
  <theme-picker .variant=${variant}></theme-picker>
`;

export const Default = Template.bind({});
Default.args = {
  variant: "default",
};
