import mozunit

LINTER = "policies-json"


def test_clean(lint, paths):
    results = lint(paths("good.json"))
    assert results == []


def test_violations(lint, paths):
    results = lint(paths("bad.json"))
    messages = [r.message for r in results]
    assert len(messages) == 2

    missing_category = [m for m in messages if "MissingCategory" in m]
    assert len(missing_category) == 1
    assert "'x-category' is a required property" in missing_category[0]

    empty_description = [m for m in messages if "EmptyDescription" in m]
    assert len(empty_description) == 1
    assert "description" in empty_description[0]
    assert "too short" in empty_description[0]


if __name__ == "__main__":
    mozunit.main()
