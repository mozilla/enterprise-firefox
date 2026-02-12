<img src="./docs/readme/readme-banner.svg" alt="Firefox for Enterprise Browser" width=2024 height=200/>

[Firefox](https://firefox.com/) is a fast, reliable and private web browser from the non-profit [Mozilla organization](https://mozilla.org/).

#### Build

Add the following line to your `.mozconfig` depending on the platform you're developing for

- macos: `. "$topsrcdir/build/macosx/mozconfig.enterprise"`
- unix: `. "$topsrcdir/build/unix/mozconfig.enterprise"`
- win64: `. "$topsrcdir/build/win64/mozconfig.enterprise"`

#### Run:

```
$ ./mach run
```

#### Tests:

```
$ ./mach marionette-test testing/enterprise/
```

You can also specify a test file, by default the manifest from the directory will be used.

OR

```
$ ./mach test marionette-enterprise
```
