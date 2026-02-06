#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import sys
from functools import wraps

from felt_tests import FeltTestsBase
from selenium.webdriver import ActionChains


# Decorator to ensure the context menu is closed after test completes as other
# wise the application refuses to quit
def close_context_menu(test_func):
    @wraps(test_func)
    def wrapper(self, *args, **kwargs):
        try:
            return test_func(self, *args, **kwargs)
        finally:
            try:
                self._driver.set_context("chrome")
                context_menu = self.find_elem_by_id("textbox-contextmenu")
                if context_menu and context_menu.get_property("state") == "open":
                    self._driver.execute_script(
                        "arguments[0].hidePopup();",
                        context_menu,
                    )
            except Exception as e:
                self._logger.warning(
                    f"Failed to close context menu during cleanup: {e}"
                )

    return wrapper


class BrowserContextMenu(FeltTestsBase):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def teardown(self):
        # Skip child browser closing since we don't use it in context menu tests
        self._manually_closed_child = True
        super().teardown()

    # Must be called when in the chrome context
    def read_clipboard(self):
        return self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            navigator.clipboard.readText().then(callback);
            """
        )

    # Must be called when in the chrome context
    def write_clipboard(self, text):
        self._driver.execute_async_script(
            """
            const callback = arguments[arguments.length - 1];
            navigator.clipboard.writeText(arguments[0]).then(callback);
            """,
            text,
        )

    @close_context_menu
    def test_email_context_menu_cut(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing cut operation on email input")

        email_input = self.get_elem("#felt-form__email")
        test_text = "test@example.com"

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = arguments[1];
            inputElement.focus();
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            inputElement.select();
            return inputElement;
            """,
            email_input,
            test_text,
        )

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        cut_item = self.get_elem("#context-cut")
        assert not cut_item.get_property("disabled"), "Cut item is enabled"
        cut_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == "", "Text was cut from email input"

        clipboard_content = self.read_clipboard()
        assert clipboard_content == test_text, "Text was copied to clipboard"

        return True

    @close_context_menu
    def test_email_context_menu_copy(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing copy operation on email input")

        email_input = self.get_elem("#felt-form__email")
        test_text = "test@example.com"

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = arguments[1];
            inputElement.focus();
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            inputElement.select();
            return inputElement;
            """,
            email_input,
            test_text,
        )

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        copy_item = self.get_elem("#context-copy")
        assert not copy_item.get_property("disabled"), "Copy item is enabled"
        copy_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == test_text, "Text remains in email input"

        clipboard_content = self.read_clipboard()
        assert clipboard_content == test_text, "Text was copied to clipboard"

        return True

    @close_context_menu
    def test_email_context_menu_paste(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing paste operation on email input")

        email_input = self.get_elem("#felt-form__email")
        clipboard_text = "pasted@example.com"

        self.write_clipboard(
            clipboard_text,
        )

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = '';
            inputElement.focus();
            return inputElement;
            """,
            email_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        paste_item = self.get_elem("#context-paste")
        assert not paste_item.get_property("disabled"), "Paste item is enabled"
        paste_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == clipboard_text, "Text was pasted into email input"

        return True

    @close_context_menu
    def test_email_context_menu_select_all(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing select all operation on email input")

        email_input = self.get_elem("#felt-form__email")
        test_text = "test@example.com"

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = arguments[1];
            inputElement.focus();
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            inputElement.setSelectionRange(0, 0);
            return inputElement;
            """,
            email_input,
            test_text,
        )

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        select_all_item = self.get_elem("#context-selectall")
        select_all_item.click()

        selection_info = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            return {
                start: inputElement.selectionStart,
                end: inputElement.selectionEnd,
                length: inputElement.value.length
            };
            """,
            email_input,
        )
        assert selection_info["start"] == 0, "Selection starts at beginning"
        assert selection_info["end"] == selection_info["length"], (
            "Selection ends at end"
        )

        return True

    @close_context_menu
    def test_email_context_menu_delete(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing delete operation on email input")

        email_input = self.get_elem("#felt-form__email")
        test_text = "test@example.com"

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = arguments[1];
            inputElement.focus();
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            inputElement.select();
            return inputElement;
            """,
            email_input,
            test_text,
        )

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        delete_item = self.get_elem("#context-delete")
        assert not delete_item.get_property("disabled"), "Delete item is enabled"
        delete_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == "", "Text was deleted from email input"

        return True

    @close_context_menu
    def test_email_context_menu_undo_redo(self, exp):
        self._driver.set_context("chrome")
        self._logger.info("Testing undo and redo operations on email input")

        email_input = self.get_elem("#felt-form__email")
        test_text = "testinput"

        actual_input = self._driver.execute_script(
            """
            let inputElement = arguments[0].shadowRoot.querySelector('input');
            inputElement.value = '';
            inputElement.focus();
            return inputElement;
            """,
            email_input,
        )

        actual_input.send_keys(test_text)

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        undo_item = self.get_elem("#context-undo")
        assert not undo_item.get_property("disabled"), "Undo item is enabled"
        undo_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == "", "Text was undone"

        actions = ActionChains(self._driver)
        actions.context_click(actual_input).perform()

        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_property("state") == "open", "Context menu is open"

        redo_item = self.get_elem("#context-redo")
        assert not redo_item.get_property("disabled"), "Redo item is enabled"
        redo_item.click()

        email_value = self._driver.execute_script(
            "return arguments[0].value;",
            email_input,
        )
        assert email_value == test_text, "Text was redone"

        return True

    def test_email_z_submit(self, exp):
        self.submit_email("random@mozilla.com")

        self._driver.set_context("chrome")
        self._logger.info("Email submitted and SSO browser displayed")
        sso_content_ready = self.get_elem(".felt-login__sso")
        assert sso_content_ready, "The SSO content is displayed"

        self._driver.set_context("content")

        return True

    @close_context_menu
    def test_login_context_menu_cut(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing cut operation on login input in SSO form")

        login_input = self.get_elem("#login")
        test_login = "testlogin"
        login_input.send_keys(test_login)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            login_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        cut_item = self.find_elem_by_id("context-cut")
        assert not cut_item.get_property("disabled"), "Cut item is enabled"
        cut_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == "", "Text was cut from login input"

        self._driver.set_context("chrome")
        clipboard_content = self.read_clipboard()
        assert clipboard_content == test_login, "Text was copied to clipboard"

        return True

    @close_context_menu
    def test_login_context_menu_copy(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing copy operation on login input in SSO form")

        login_input = self.get_elem("#login")
        test_login = "testlogin"
        login_input.send_keys(test_login)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            login_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        copy_item = self.find_elem_by_id("context-copy")
        assert not copy_item.get_property("disabled"), "Copy item is enabled"
        copy_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == test_login, "Text remains in login input"

        self._driver.set_context("chrome")
        clipboard_content = self.read_clipboard()
        assert clipboard_content == test_login, "Text was copied to clipboard"

        return True

    @close_context_menu
    def test_login_context_menu_paste(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing paste operation on login input in SSO form")

        self._driver.set_context("chrome")
        clipboard_text = "pastedlogin"
        self.write_clipboard(
            clipboard_text,
        )

        self._driver.set_context("content")
        login_input = self.get_elem("#login")
        login_input.clear()

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        paste_item = self.find_elem_by_id("context-paste")
        assert not paste_item.get_property("disabled"), "Paste item is enabled"
        paste_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == clipboard_text, "Text was pasted into login input"

        return True

    @close_context_menu
    def test_login_context_menu_select_all(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing select all operation on login input in SSO form")

        login_input = self.get_elem("#login")
        login_input.clear()
        test_login = "testlogin"
        login_input.send_keys(test_login)

        self._driver.execute_script(
            """
            arguments[0].setSelectionRange(0, 0);
            """,
            login_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        select_all_item = self.find_elem_by_id("context-selectall")
        select_all_item.click()

        self._driver.set_context("content")

        def selection_complete(_driver):
            info = self._driver.execute_script(
                """
                return {
                    start: arguments[0].selectionStart,
                    end: arguments[0].selectionEnd,
                    length: arguments[0].value.length
                };
                """,
                login_input,
            )
            return info["start"] == 0 and info["end"] == info["length"]

        self._wait.until(selection_complete, "Selection was applied")

        selection_info = self._driver.execute_script(
            """
            return {
                start: arguments[0].selectionStart,
                end: arguments[0].selectionEnd,
                length: arguments[0].value.length
            };
            """,
            login_input,
        )
        assert selection_info["start"] == 0, "Selection starts at beginning"
        assert selection_info["end"] == selection_info["length"], (
            "Selection ends at end"
        )

        return True

    @close_context_menu
    def test_login_context_menu_delete(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing delete operation on login input in SSO form")

        login_input = self.get_elem("#login")
        test_login = "testlogin"
        login_input.send_keys(test_login)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            login_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        delete_item = self.find_elem_by_id("context-delete")
        assert not delete_item.get_property("disabled"), "Delete item is enabled"
        delete_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == "", "Text was deleted from login input"

        return True

    @close_context_menu
    def test_login_context_menu_undo_redo(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing undo and redo operations on login input in SSO form")

        login_input = self.get_elem("#login")
        test_text = "testinput"

        login_input.clear()
        login_input.send_keys(test_text)

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        undo_item = self.find_elem_by_id("context-undo")
        assert not undo_item.get_property("disabled"), "Undo item is enabled"
        undo_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == "", "Text was undone"

        actions = ActionChains(self._driver)
        actions.context_click(login_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        redo_item = self.find_elem_by_id("context-redo")
        assert not redo_item.get_property("disabled"), "Redo item is enabled"
        redo_item.click()

        self._driver.set_context("content")

        login_value = login_input.get_attribute("value")
        assert login_value == test_text, "Text was redone"

        return True

    @close_context_menu
    def test_password_context_menu_cut(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing cut is disabled on password input in SSO form")

        password_input = self.get_elem("#password")
        test_password = "testpass123"
        password_input.send_keys(test_password)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            password_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        cut_item = self.find_elem_by_id("context-cut")
        assert cut_item.get_property("disabled"), (
            "Cut item is disabled on password input"
        )

        return True

    @close_context_menu
    def test_password_context_menu_copy(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing copy is disabled on password input in SSO form")

        password_input = self.get_elem("#password")
        test_password = "testpass123"
        password_input.send_keys(test_password)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            password_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        copy_item = self.find_elem_by_id("context-copy")
        assert copy_item.get_property("disabled"), (
            "Copy item is disabled on password input"
        )

        return True

    @close_context_menu
    def test_password_context_menu_paste(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing paste operation on password input in SSO form")

        self._driver.set_context("chrome")
        clipboard_text = "pastedpass"
        self.write_clipboard(
            clipboard_text,
        )

        self._driver.set_context("content")
        password_input = self.get_elem("#password")
        password_input.clear()

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        paste_item = self.find_elem_by_id("context-paste")
        assert not paste_item.get_property("disabled"), "Paste item is enabled"
        paste_item.click()

        self._driver.set_context("content")

        password_value = password_input.get_attribute("value")
        assert password_value == clipboard_text, "Text was pasted into password input"

        return True

    @close_context_menu
    def test_password_context_menu_select_all(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing select all operation on password input in SSO form")

        password_input = self.get_elem("#password")
        password_input.clear()
        test_password = "testpass123"
        password_input.send_keys(test_password)

        self._driver.execute_script(
            """
            arguments[0].setSelectionRange(0, 0);
            """,
            password_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        select_all_item = self.find_elem_by_id("context-selectall")
        select_all_item.click()

        self._driver.set_context("content")

        def selection_complete(_driver):
            info = self._driver.execute_script(
                """
                return {
                    start: arguments[0].selectionStart,
                    end: arguments[0].selectionEnd,
                    length: arguments[0].value.length
                };
                """,
                password_input,
            )
            return info["start"] == 0 and info["end"] == info["length"]

        self._wait.until(selection_complete, "Selection was applied")

        selection_info = self._driver.execute_script(
            """
            return {
                start: arguments[0].selectionStart,
                end: arguments[0].selectionEnd,
                length: arguments[0].value.length
            };
            """,
            password_input,
        )
        assert selection_info["start"] == 0, "Selection starts at beginning"
        assert selection_info["end"] == selection_info["length"], (
            "Selection ends at end"
        )

        return True

    @close_context_menu
    def test_password_context_menu_delete(self, exp):
        self._driver.set_context("content")
        self._logger.info("Testing delete operation on password input in SSO form")

        password_input = self.get_elem("#password")
        test_password = "testpass123"
        password_input.send_keys(test_password)

        self._driver.execute_script(
            """
            arguments[0].select();
            """,
            password_input,
        )

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        delete_item = self.find_elem_by_id("context-delete")
        assert not delete_item.get_property("disabled"), "Delete item is enabled"
        delete_item.click()

        self._driver.set_context("content")

        password_value = password_input.get_attribute("value")
        assert password_value == "", "Text was deleted from password input"

        return True

    @close_context_menu
    def test_password_context_menu_undo_redo(self, exp):
        self._driver.set_context("content")
        self._logger.info(
            "Testing undo and redo operations on password input in SSO form"
        )

        password_input = self.get_elem("#password")
        test_password = "testpass123"

        password_input.clear()
        password_input.send_keys(test_password)

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        undo_item = self.find_elem_by_id("context-undo")
        assert not undo_item.get_property("disabled"), "Undo item is enabled"
        undo_item.click()

        self._driver.set_context("content")

        password_value = password_input.get_attribute("value")
        assert password_value == "", "Text was undone"

        actions = ActionChains(self._driver)
        actions.context_click(password_input).perform()

        self._driver.set_context("chrome")
        context_menu = self.find_elem_by_id("textbox-contextmenu")
        assert context_menu.get_attribute("state") == "open", "Context menu is open"

        redo_item = self.find_elem_by_id("context-redo")
        assert not redo_item.get_property("disabled"), "Redo item is enabled"
        redo_item.click()

        self._driver.set_context("content")

        password_value = password_input.get_attribute("value")
        assert password_value == test_password, "Text was redone"

        return True


if __name__ == "__main__":
    BrowserContextMenu(
        "felt_browser_context_menu.json",
        firefox=sys.argv[1],
        geckodriver=sys.argv[2],
        profile_root=sys.argv[3],
        env_vars={"MOZ_FELT_UI": "1"},
    )
