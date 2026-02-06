<img src="./docs/readme/readme-banner.svg" alt="Firefox for Enterprise Browser" width=2024 height=200/>

[Firefox](https://firefox.com/) is a fast, reliable and private web browser from the non-profit [Mozilla organization](https://mozilla.org/).

#### Build

Add the following line to your `.mozconfig` depending on the platform you're developing for

- macos: `. "$topsrcdir/build/macosx/mozconfig.enterprise"`
- unix: `. "$topsrcdir/build/unix/mozconfig.enterprise"`
- win64: `. "$topsrcdir/build/win64/mozconfig.enterprise"`

Note that this may strip debug symbols in spite of other settings in your .mozconfig. Have a look at [build/mozconfig.common.enterprise](build/mozconfig.common.enterprise) if you need to change that.

#### Run:
`./mach run -feltUI`
