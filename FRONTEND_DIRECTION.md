# LastResort Frontend Direction

Ticket Studio is the selected visual direction for LastResort. Warm paper, dark ink, brick orange, and restrained ticket geometry should make a limited-resource reservation feel understandable and dependable. The visual identity supports a clear transaction: understand the event, review one ticket, confirm once, see the result, and reopen it later.

This is a design specification, including components anticipated for the first release and conditional concepts for later releases. It does not change implementation status or authorize additional product features. The engineering guide and API contract govern behavior. Application UI and product copy remain in English.

## Product boundaries

The first release has one fictional event, pooled general admission, one ticket per request, free admission, immediate confirmation, and a server-owned guest session. Reviewing a booking holds no inventory. Another deliberate operation may reserve another ticket; recovery must preserve the original operation.

History belongs to the same browser and its guest cookie. A reference identifies a reservation but grants no access. Clearing cookies or using another browser cannot recover reservations in this release. Surface this limitation before confirmation and in history.

The current contract implements health and event details. Reservation creation and detail are planned; history and operation discovery still need their task-specific contracts. The screens below describe intended behavior as those capabilities arrive. A disabled or preview action must never imply that its endpoint is implemented.

## Design principles

1. **State before decoration.** A user should immediately recognize whether sales are open, a request is being sent, an outcome is unknown, or a ticket is confirmed.
2. **A ticket is a useful container.** Separate event information from the action or reservation reference with a perforated seam. Keep operational errors on plain surfaces.
3. **One dominant decision.** Each page has one primary action. Secondary actions stay visible and quieter.
4. **Earn confidence through specifics.** Use actual dates, quantities, and server results. Display unknown values as unavailable; never substitute zero for a failed availability read.
5. **Design the interruption.** Reloads, response loss, unavailable data, long titles, and missing ownership context receive deliberate layouts and copy.
6. **Use restraint consistently.** Whitespace, aligned type, and clear grouping carry the design. Ticket cutouts and uppercase labels appear selectively.

## Visual foundations

### Color tokens

Use semantic names in application CSS. This palette defines the first release's fixed light theme. A dark theme requires a separate contrast and state review.

| Token | Value | Purpose |
| --- | --- | --- |
| `--lr-canvas` | `#EFECE4` | Page background |
| `--lr-paper` | `#FFFAF0` | Ticket and primary content surface |
| `--lr-ink` | `#2B2925` | Essential text and headings |
| `--lr-muted` | `#615F57` | Secondary text that remains readable |
| `--lr-line` | `#C8C1B3` | Decorative separators and ticket seams |
| `--lr-control-line` | `#857D70` | Input and secondary-button boundaries |
| `--lr-brand` | `#B84122` | Primary action and selective brand emphasis |
| `--lr-brand-hover` | `#96351C` | Primary action hover and pressed state |
| `--lr-on-brand` | `#FFF9EC` | Text on brand surfaces |
| `--lr-focus` | `#285D99` | Keyboard focus indicator |
| `--lr-success` / `--lr-success-bg` | `#355133` / `#E2E7D7` | Sales open and confirmed, distinguished by text and icon |
| `--lr-warning` / `--lr-warning-bg` | `#76520E` / `#F6EACD` | Waiting or uncertain operation outcome |
| `--lr-danger` / `--lr-danger-bg` | `#8C302B` / `#F8E6E1` | Actionable failure or destructive action |
| `--lr-info` / `--lr-info-bg` | `#374F70` / `#E7EDF4` | Informational notices and checking status |

Computed solid-color contrast: ink on paper 13.95:1; muted on paper 6.15:1; on-brand on brand 5.24:1; success pair 7.01:1; warning pair 5.89:1; danger pair 6.76:1; info pair 7.09:1. Control-line on paper is 3.91:1. These calculations cover these pairs, not every rendered combination or a full accessibility audit. Do not lower opacity on essential text.

### Typography

Use Space Grotesk with `Arial, sans-serif` fallback. Self-host the chosen font through the existing Next.js setup when implementing; avoid a runtime font dependency. Use regular 400, medium 500, and bold 700 sparingly. A system monospace face is reserved for complete reservation references.

| Role | Desktop | Mobile | Usage |
| --- | --- | --- | --- |
| Event display | 56/58px | 36/40px | One expressive event heading |
| Page title | 36/42px | 28/34px | Review, result, and history |
| Section title | 24/30px | 22/28px | Ticket sections and state headings |
| Body | 16/25px | 16/25px | Reading text and important explanations |
| Supporting text | 14/21px | 14/21px | Metadata and help |
| Eyebrow or compact label | 12/18px | 12/18px | Short uppercase labels only |
| Inventory count | 56/56px | 44/48px | Actual available inventory |

Use `rem` units in implementation and allow text resizing. Body copy uses sentence case. Uppercase display lettering may identify the event; review, errors, and long paragraphs remain sentence case. Use tabular numerals for counts and aligned dates, not every heading.

### Geometry and spacing

Use a 4px spacing scale: 4, 8, 12, 16, 24, 32, 48, 64. Default content padding is 24–32px desktop and 16–20px mobile. Keep short labels 8px from their values and separate independent content groups by at least 24px.

Use 8px ticket radii, 6px control radii, 1px surface borders, and a 2px dashed seam only at the ticket split. Cutouts are decorative CSS and hidden from assistive technology. A ticket has one seam; nested tickets and repeated perforations dilute the hierarchy. Omit cutouts when the surrounding surface cannot be matched reliably.

Keep surfaces flat. Reserve a modest shadow for a floating overlay if a later feature needs one. Avoid paper textures behind text, fake barcodes, fake QR codes, glowing borders, confetti, automatic motion, and ornamental scarcity messages.

## Responsive composition

| Available width | Layout rule |
| --- | --- |
| Below 640px | One column; 16px page gutters; ticket details above action stub; horizontal seam; full-width primary action |
| 640–899px | Keep booking content stacked when labels or controls would be cramped; 24px gutters |
| 900px and above | Event ticket uses roughly 60% details / 40% action stub; 32px gutters; maximum shell width 1120px |

Review and result use a quieter reading width of approximately 760px. History uses a vertical list. Avoid introducing a sidebar or hamburger menu for two navigation destinations. The header contains the wordmark, Event, and My bookings; the demo label is plain text.

Use document scrolling. Keep the confirmation action after its summary in reading order. A sticky mobile action is optional only if measured usability warrants it and safe-area padding, zoom, focus visibility, and content clearance are verified. Do not use fixed card heights in the application. Wrap long event names, venue names, and references; preserve the complete value. At 320px, stack actions and metadata without horizontal scrolling.

## Screen specifications

### Event details

Begin with a small event label, then the event name. The main ticket contains date, explicit Bangkok time, venue, ticket type, and a short description. The action stub contains sale status, remaining count, Free, one-ticket policy, and Review booking. Give the event name and the action more visual weight than decorative identifiers.

Show both sale boundaries in a compact details section. The event label stays factual; do not claim featured artists, venue services, entry requirements, or a saved place that the demo does not provide. The default event is Live Sessions (Demo), 21 November 2026 at 7 PM, Demo Hall. Sales open 1 October at 7 AM and close 21 November at 6 PM, all Bangkok time (UTC+7).

Refresh availability is secondary. Preserve the last successful details during an explicit refresh where possible, label the count as updating, and temporarily block advancing on an unverified snapshot. If refresh fails, retain a visible stale-data warning and retry action; never relabel stale inventory as current. Final reservation availability always comes from the server transaction.

### Review booking

Use a page title and a factual summary: event, date and timezone, venue, General admission × 1, and Total: Free. There is no quantity selector, checkout form, payment card, email field, or invented terms checkbox.

Place these two notices before Confirm reservation:

- "Reviewing does not reserve a ticket. Availability is checked when you confirm."
- "Your booking is saved in this browser. Clearing cookies or using another browser will remove access."

Back to event is a secondary navigation action. It does not cancel anything. Confirmation is a single explicit button, not an additional confirmation modal. A sale-window or availability rejection appears beside the summary with its specific next action.

### Submission and result

Keep the summary visible while sending. Change the primary label to Confirming reservation…, retain its width, disable duplicate submission, and announce progress. Pending describes a client operation, not a held ticket or a server reservation status.

Confirmed results start with a success icon and "You're confirmed". Show the ticket summary, quantity, full reservation reference, and reservation timestamp. Primary action: View my bookings. A secondary Copy reference action confirms success with "Reference copied"; clipboard failure leaves a selectable reference and instructions. Reopening a confirmed result displays the same reservation without another mutation.

An unknown outcome starts with "We haven't confirmed the result yet" and "Your request may have completed. Check its result before starting another booking." Preserve the original operation identity and offer Check booking result. Further retry resends that same operation only when the implemented contract supports it. Keep unknown operations visually distinct from confirmed tickets and prohibit a silent new booking. Recovery stays available if the event is now closed or sold out; those sale states do not establish the original request's outcome. Reading an older confirmed ticket does not resolve a different unknown operation. A slow response alone never proves failure.

### History and reservation detail

History title: My bookings. Show the same-browser limitation once near the title. A confirmed reservation row contains event name, event date/time, status, quantity, reference, and View booking. Give each row one navigation target; keep Copy reference in detail to avoid nested interactive targets. Sort confirmed reservations by creation time descending when the history contract defines that ordering.

Empty copy: "No bookings in this browser yet." Action: View event. An operation awaiting discovery belongs in a separate "Booking result to check" notice, not the confirmed list. If ownership is unavailable, explain that the browser cannot access those bookings. An unknown or unauthorized reference uses the same not-found presentation; do not reveal whether someone else's reservation exists. Do not offer recovery by entering a reference or email in this release.

## State and action matrix

Sale state and operation state are separate models. Sale states use `not_open`, `open`, `closed`, and `sold_out` from the API. The server Reservation schema currently has only `confirmed`. UI states below must not become invented reservation statuses in payloads.

| Situation | Visible message | Primary action | Guardrail |
| --- | --- | --- | --- |
| Initial loading | Loading event details… | None until resolved | Skeleton has no fabricated counts |
| Sales not open | Sales open [date and Bangkok time] | No reservation action | Preserve event details |
| Sales open | Sales are open · [remaining] tickets remaining | Review booking | Reviewing has no inventory effect |
| Sold out | All tickets have been reserved | No reservation action | No waitlist or cancellation promise |
| Sales closed | Sales closed [date and Bangkok time] | No reservation action | Existing confirmed tickets remain valid |
| Event unavailable | We couldn't load this event | Try again | Do not display zero inventory |
| Event not found | This event isn't available | Check again | No database/internal details |
| Submitting | Confirming reservation… | Busy confirmation control | Preserve operation and block duplicates |
| Confirmed | You're confirmed | View my bookings | Server confirmation precedes success |
| Business rejection | Tickets sold out before confirmation / Sales closed / Sales not open | Back to event | No ticket or entitlement shown |
| Unknown outcome | We haven't confirmed the result yet | Check booking result | Preserve original operation across reload |
| Known retryable technical failure | We couldn't complete this request | Retry the same request | Use only if rollback/noncommit is established |
| Changed operation payload | This request no longer matches the original booking | Return to the original request | Do not silently replace the operation key |
| Empty history | No bookings in this browser yet | View event | Do not imply server-wide emptiness |
| Missing session | This browser can't access those bookings | View event | Explain same-browser access, no false recovery |
| Detail not found or not owned | This booking isn't available in this browser | My bookings | Identical ownership-safe presentation |

## Component inventory for the first release

Names below are proposed design boundaries. Implement a shared component when the selected slice needs it or behavior is actually reused; do not create empty components or a generic framework to match this inventory.

| Component | Anatomy and variants | Behavior and constraints |
| --- | --- | --- |
| `AppShell` | Canvas, reading container, skip link, main, footer | One document scroll; language and page landmarks |
| `SiteHeader` | Wordmark, Event, My bookings, demo label | Native navigation; active destination; wrapping mobile layout |
| `PageHeading` | Optional eyebrow, title, supporting text | One H1; title wraps naturally |
| `Button` | Primary, secondary, destructive; idle, hover, focus, pressed, busy, disabled | Native button; 44px minimum touch target; link for navigation |
| `TextLink` | Inline or standalone; optional direction icon | Underlined or otherwise explicit; expanded touch target where standalone |
| `StatusBadge` | Text and optional icon for sale or operation state | Display only; never looks like a selector |
| `Notice` | Info, success, warning, danger; heading, explanation, action | Persistent for important state; polite status or alert as appropriate |
| `TicketFrame` | Detail region and stub; vertical or horizontal seam | Decorative geometry independent of semantic structure |
| `EventIdentity` | Actual name, optional event category, short description | No required image; no hardcoded line breaks in arbitrary event names |
| `EventFacts` | Labeled date/time, venue, ticket type | Semantic description list; explicit timezone |
| `SaleWindow` | Opens and closes labels | Full dates; inclusive opening/exclusive closing behavior from server |
| `AvailabilityPanel` | Status, count or unknown value, refresh, freshness notice | Never derives sellability from count alone |
| `PriceSummary` | Ticket label, quantity, total | First release says Free; integer minor units remain server data |
| `BookingActionPanel` | Availability, price, one-ticket policy, action | One dominant action; unavailable reason remains readable |
| `BookingSummary` | Event facts, one ticket, total | Reused across review, result, and detail; no mutable ownership fields |
| `GuestAccessNotice` | Same-browser policy and concise explanation | Present before confirmation and on history; no user identifiers |
| `BookingProgress` | Review, confirming, result labels | Optional plain text; no misleading held/payment stage |
| `SubmissionState` | Busy action plus persistent summary | Prevent duplicate sends; no fake percentage or countdown |
| `ResultPanel` | Outcome icon, title, explanation, appropriate action | Outcome selects variant; confirmed is the only ticket-success treatment |
| `ConfirmedTicket` | Confirmed status, summary, reference, timestamp | Render only from a confirmed reservation |
| `ReferenceBlock` | Full UUID, Copy reference, inline feedback | Wrap or segment visually without altering copied value |
| `OperationRecoveryPanel` | Unknown status, original-request summary, checking/retry action | Separate from confirmed ticket; maintain original operation identity |
| `ReservationList` / `ReservationRow` | Heading and one destination per confirmed row | Semantic list, clear accessible link name, no nested buttons |
| `EmptyState` | Short title, explanation, one action | Context-specific wording for history |
| `UnavailableState` | Plain state surface, title, retry | Safe message; keep known context during refresh failure |
| `Skeleton` | Neutral placeholders matching major content geometry | Static under reduced motion; `aria-busy`; no invented content |
| `InlineFeedback` | Copied or action feedback near its trigger | Polite announcement; important failures remain persistent |

Shared components accept already-authorized presentation data. Small route-specific client controllers own fetching and operation transitions; server modules retain ownership and business rules. Keep the existing Next.js/React/CSS stack. This direction does not introduce Tailwind, a component library, a state library, or an icon package; assess any dependency separately when implementing. Use a small consistent icon set, with decorative icons hidden and visible labels on meaningful actions.

## Conditional designs for later releases

These concepts are intentionally anticipated, not implementation commitments. Their presence in a design sheet does not place them in the current app navigation.

| Component | Proposed design | Prerequisite and important states |
| --- | --- | --- |
| `EventCard` / `EventCollection` | Small date block, name, venue, sale label; whole-card navigation | Multiple events selected as scope; loading, empty, unavailable, pagination if needed |
| `ResourceOption` | Labeled selectable row with capacity/schedule facts | Multiple ticket/resource types authorized; available, unavailable, selected, stale selection |
| `QuantityField` | Labeled number input with explicit bounds | Multi-ticket rules authorized; min/max feedback and authoritative server limits |
| `HoldNotice` | Calm expiry notice beside summary with server expiry time | A real persisted hold model; active, reconnecting, expiring, expired; never start a timer on review in this release |
| `CancellationDialog` | Reservation identity, exact consequence, explicit destructive action | Cancellation policy and atomic inventory behavior; confirming, cancelled, failed, unknown |
| `PaymentSummary` / `PaymentResult` | Itemized amount and separately labeled payment and ticket statuses | Payment scope and provider contract; pending, declined, refunded, unknown; payment success alone does not prove ticket issuance |
| `QueueStatus` | Plain waiting state with last verified status | Actual waiting-room service and server status; no invented position, ETA, or linear progress |
| `AccountRecovery` | Separate identity and recovery journey | Account model, authentication and authorization design; never repurpose the guest reference as proof of ownership |
| `ActivityTimeline` | Dated factual operation events with individual statuses | Reconciliation/audit APIs selected as scope; show verified events and explicit unknown intervals |
| `HistoryFilters` / `Pagination` | Compact labeled controls above list, preserved navigation state | History volume and contract justify them; avoid unnecessary filters for one event |

Anticipate extension through labeled content slots and semantic tokens. Keep the ticket anatomy useful for a date, resource name, summary, and outcome, while allowing ticket-specific decoration to be removed for another domain. Do not design seat maps, administrative dashboards, or data pipelines into the first-release shell without a selected product need.

## Interaction and accessibility

Target WCAG 2.2 AA. Normal text needs at least 4.5:1 contrast, with the large-text exception defined by [W3C Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Essential control boundaries and focus indicators need distinct visible contrast. A 44×44 CSS-pixel touch target is this project's design target; [WCAG Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) defines its own 24px minimum and exceptions.

Use a 3px focus outline with 3px offset and ensure focus is visible on every surrounding surface. Author-created sticky content or overlays must not completely hide focused controls, consistent with [W3C Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html). Keep native tab order, Enter/Space activation, visible labels, and meaningful link names. A route or major local view change places focus at the new heading; validation failure moves attention to its explanation without disrupting ordinary refreshes.

Status changes use polite live announcements; actionable submission errors use an alert. Do not repeatedly announce an unchanged count. Status always has words and may have an icon; color never carries the only meaning. Future dialogs require a title, deliberate initial focus, contained keyboard navigation, Escape behavior, and focus restoration.

Use 120–180ms color/border transitions. Respect reduced motion and omit decorative animated counters, looping pulses, and simulated loading percentages. Keep button dimensions stable during submission and preserve layout during data loading. Use real text rather than text rendered into images. Preserve usability at 200% text enlargement and 320px layout width, including long content.

## Copy system

Use Review booking before mutation, Confirm reservation for the mutation, Confirming reservation… while sending, View my bookings after success, and Check booking result for uncertainty. Use Ticket for the entitlement, Reservation for the recorded transaction, and Reference for its identifier. Keep user-facing recovery copy free of operation keys, driver errors, and infrastructure terminology.

Use specific state explanations rather than blame or urgency. "This ticket is saved for you" is appropriate only after confirmation. "Only X left", countdown pressure, queue estimates, payment language, cancellation links, and cross-device recovery claims need actual product support before appearing.

## Implementation sequence and design acceptance

1. Establish tokens, typography, shell, controls, and event ticket while preserving the existing event API behavior.
2. Add review and guest-access notices with the session task. Activate confirmation only with its actual route and transaction behavior.
3. Add confirmed result, ownership-safe detail, reference actions, and applicable error states with their server contracts.
4. Add history and persistent operation recovery as their contracts and server guarantees are implemented. Unknown outcomes must already receive an honest blocked/recovery presentation whenever a mutation is exposed.
5. Implement future concepts only when their prerequisite feature is selected. Extract shared components from real reuse.

For each implemented slice, inspect at 320, 390, 768, 1024, and 1440px; keyboard navigation; 200% text; reduced motion; long event/venue names; long references; slow loads; unavailable responses; sold out between review and confirmation; cookie loss; and response loss after commit where relevant. Check contrast on rendered surfaces, complete reference copying, focus after view changes, absence of fake success, and same-operation recovery. These are acceptance checks to execute on the application, not completed verification claims from a design prototype.

The companion preview demonstrates this visual system with local sample data only. Previewing a simulated confirmation, history row, or future component does not establish API implementation, inventory correctness, ownership protection, or accessibility conformance.
