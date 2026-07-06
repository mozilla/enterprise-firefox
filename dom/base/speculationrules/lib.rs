/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use nsstring::nsACString;
use thin_vec::ThinVec;
use url::Url;
use urlpattern::UrlPattern;

mod parser;

#[derive(Debug)]
pub struct SpeculationRuleSet(pub ThinVec<SpeculationRule>);

#[derive(Debug, Default)]
pub enum UrlSearchVariance {
    #[default]
    Default,
    String(String),
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct Selector(String);

#[derive(Debug, Eq, PartialEq, PartialOrd, Ord, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Eagerness {
    Immediate = 3,
    Eager = 2,
    Moderate = 1,
    Conservative = 0,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReferrerPolicy {
    #[serde(rename = "")]
    Empty,
    NoReferrer,
    NoReferrerWhenDowngrade,
    SameOrigin,
    Origin,
    StrictOrigin,
    OriginWhenCrossOrigin,
    StrictOriginWhenCrossOrigin,
    UnsafeUrl,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Requirement {
    AnonymousClientIpWhenCrossOrigin,
}

#[derive(Debug)]
pub enum Predicate {
    Conjunction(ThinVec<Predicate>),
    Disjunction(ThinVec<Predicate>),
    Negation(Box<Predicate>),
    UrlPattern(ThinVec<UrlPattern>),
    Selector(ThinVec<Selector>),
}

#[allow(dead_code)]
#[derive(Debug)]
pub struct SpeculationRule {
    urls: ThinVec<Url>,
    predicate: Option<Predicate>,
    eagerness: Eagerness,
    referrer_policy: ReferrerPolicy,
    tags: ThinVec<Option<String>>,
    requirements: ThinVec<Requirement>,
    no_vary_search_hint: UrlSearchVariance,
}

#[derive(Debug, Default)]
#[repr(C)]
pub enum SpeculationRuleParseError {
    #[default]
    None,
    TopLevelValueMustBeJsonObject,
    InvalidTag,
    InvalidBaseUrl,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn parse_speculation_rule_set(
    rules: &nsACString,
    document_base_url: &nsACString,
    base_url: &nsACString,
    parse_error: &mut SpeculationRuleParseError,
) -> *mut SpeculationRuleSet {
    // This will fail if this has already been called, but this isn't a problem because either way,
    // logging has been initialized.
    let _ = env_logger::try_init();

    *parse_error = SpeculationRuleParseError::None;
    let Ok(document_base_url) = Url::parse(&document_base_url.to_utf8()) else {
        *parse_error = SpeculationRuleParseError::InvalidBaseUrl;
        return std::ptr::null_mut();
    };
    let Ok(base_url) = Url::parse(&base_url.to_utf8()) else {
        *parse_error = SpeculationRuleParseError::InvalidBaseUrl;
        return std::ptr::null_mut();
    };
    match SpeculationRuleSet::parse(&rules.to_utf8(), &document_base_url, &base_url) {
        Ok(rules) => Box::leak(Box::new(rules)),
        Err(error) => {
            *parse_error = error;
            std::ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn speculation_rule_set_destroy(rules: *mut SpeculationRuleSet) {
    let _ = unsafe { Box::from_raw(rules) };
}
