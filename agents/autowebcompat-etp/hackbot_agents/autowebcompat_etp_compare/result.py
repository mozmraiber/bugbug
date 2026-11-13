"""Result models for the autowebcompat-etp-compare agent."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

RESULT_SERVER_NAME = "autowebcompat-etp-compare"

# The configurations the site is loaded in, in load order. `off` is the
# reference the others are compared against.
Configuration = Literal["off", "strict", "easyprivacy", "easylist"]
BlockingConfiguration = Literal["strict", "easyprivacy", "easylist"]

# Configuration -> the set_etp_mode mode that sets it up.
ETP_MODES: dict[Configuration, str] = {
    "off": "off",
    "strict": "strict",
    "easyprivacy": "strict/easyprivacy",
    "easylist": "strict/easylist+easyprivacy",
}

CONFIGURATION_LABELS: dict[Configuration, str] = {
    "off": "No tracker blocking",
    "strict": "Strict ETP",
    "easyprivacy": "Strict ETP with the EasyPrivacy list",
    "easylist": "Strict ETP with EasyList and EasyPrivacy",
}

# - sites_same: the site looks the same in every configuration, or the only
#   differences are ones a reload of the same configuration also shows.
# - broken: at least one blocking configuration breaks the site.
# - site_unavailable: the site doesn't load even without tracker blocking
#   (down, a block page, a captcha), so there is nothing to compare.
Outcome = Literal["sites_same", "broken", "site_unavailable"]


class ComparisonVerdict(BaseModel):
    """What the agent submits after looking at the differences."""

    outcome: Annotated[
        Outcome,
        Field(
            description="""One of:
          * sites_same - Every difference from the `off` screenshot is a variation
          that also shows when you reload the site in the same configuration (ads,
          rotating banners, carousels, timestamps, recommendations, lazy-loaded
          images, cookie banners appearing or not), or a tracker-only element
          (an ad slot, a tracking pixel) being gone without the page losing
          content or function
          * broken - In at least one blocking configuration, the site loses content
          or function it has without tracker blocking: blank or partly rendered
          page, missing main content, an error or "disable your ad blocker" wall,
          broken layout, a widget the page depends on missing
          * site_unavailable - The site doesn't load even in `off` (down, an error
          page, a captcha or bot-protection block), so nothing can be compared"""
        ),
    ]

    broken_configurations: Annotated[
        list[BlockingConfiguration],
        Field(
            description=(
                "Every blocking configuration that breaks the site. Non-empty "
                "exactly when `outcome` is `broken`."
            ),
        ),
    ]

    summary: Annotated[
        str,
        Field(
            description="""2-4 sentences: what differs between the configurations and why
        you judged it a reload variation or breakage; for each broken configuration,
        what is broken. Hard limit: 500 characters."""
        ),
    ]

    @model_validator(mode="after")
    def validate_broken_configurations(self) -> ComparisonVerdict:
        if (self.outcome == "broken") != bool(self.broken_configurations):
            raise ValueError(
                "broken_configurations must be non-empty exactly when outcome is broken"
            )
        return self


class ScreenshotDiff(BaseModel):
    """How a configuration's screenshot differs from the `off` one."""

    identical: bool
    size: tuple[int, int]
    reference_size: tuple[int, int]
    # Bounding box (left, top, right, bottom) of the differing pixels, and their
    # share of the page; None when the sizes differ.
    bbox: tuple[int, int, int, int] | None = None
    changed_fraction: float | None = None


class EtpComparisonResult(BaseModel):
    url: str
    outcome: Outcome
    broken_configurations: list[BlockingConfiguration]
    summary: str
    # `Blocked trackers` from the content blocking log after each load.
    blocked_trackers: dict[Configuration, int]
    blocked_tracker_origins: dict[Configuration, list[str]]
    # Each blocking configuration's screenshot compared to the `off` one.
    screenshot_diffs: dict[BlockingConfiguration, ScreenshotDiff]
    # False when the screenshots were identical and the agent never ran.
    llm_used: bool
    screenshot_urls: dict[str, str]
    content_blocking_log_url: str | None = None
