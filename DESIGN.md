# SSHZYU — frontend design direction

## Visual thesis
A quiet, precise API workspace: porcelain white, graphite typography, soft continuous corners, and one clear blue accent. The brand is expressed through a compact interlocking S mark and generous, consistent spacing, rather than gradients or decorative dashboard tiles.

## Content plan
- Public home: directly reference the composition at https://codexcn.ccwu.cc/ (user direction): slim full-width navigation, centered large line-art brand symbol, welcome label, dominant wordmark, short API proposition, restrained exploration action, fine section dividers, then numbered capability sections. Use an original S mark and our existing real capabilities rather than the reference brand or unverified numerical claims. Preserve custom-home and compact-home modes.
- Authentication: a quiet branded header, a focused form on a white surface, existing providers, agreements, validation and footer actions unchanged.
- Workspace: familiar navigation and every existing menu/permission; a restrained sidebar, clear page title, compact account utilities, then the actual working content.
- Data pages: consistent toolbar, filters, readable tables, pagination and dialogs. Preserve all columns, labels, formats and interactions.
- Dashboards: typographic metrics with neutral icons, readable charts, recent activity and existing quick actions. No fabricated service metrics or marketing inside operational pages.

## Interaction thesis
1. Small, quick content entrances (opacity + 6px translate) rather than perpetual animation.
2. Quiet navigation selection and 160ms hover/focus feedback.
3. Soft dialog and dropdown appearance; honor prefers-reduced-motion throughout.

## Design tokens
- Canvas: #f5f5f7; surface: #ffffff; ink: #1d1d1f; secondary: #6e6e73; divider: #e5e5e7.
- Accent: #0071e3; hover: #0062c6; soft selected background: #eaf3ff.
- Dark mode remains functional: neutral charcoal surfaces, light text, accessible blue actions.
- Font stack: "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif. Use the user's installed fonts; do not distribute proprietary font files.
- Control corners: 10–12px; surface corners: 18–24px. Avoid nested card decoration.
- Spacing: 4px base, 24px normal content rhythm, 32px main desktop inset.
- Numbers: tabular figures; headings: semibold; icon stroke weight: approximately 1.7.
- Status colors remain semantic (success, warning, failure), never recolor important states into neutral decoration.

## Implementation boundaries
Frontend presentation only. No API contracts, routes/guards, store business behavior, billing, auth, account data, payment logic, database schema, backend binary or container changes. Preserve administrator-configurable branding and menus; SSHZYU is the default display identity when settings still contain upstream Sub2API defaults. Preserve dark mode, i18n, reduced motion, responsive behavior, and accessibility.

## Release constraints
Start from production commit 2bc8cf91fd5d702a1284407e5c8f5114ac333ef3. Build and verify locally. Keep the running backend, PostgreSQL and Redis intact. Publish versioned static assets with a reversible nginx configuration change only after preflight, backup and health checks. Keep old assets available to already-open browser sessions.
