---
name: angular-coding-standards
description: Implement, review, or refactor Optipass Angular frontend code according to the repository's component, layout, SCSS, service, directive, and testing conventions. Use for changes under apps/web, especially when creating Angular components, shared UI primitives, templates, styles, stateful services, or directives. Treat the user-defined standards in this skill as authoritative even when older code differs.
---

# Optipass Angular Coding Standards

## Apply the standard over legacy code

Treat this skill as the normative rule set. Existing code may predate it and must not justify copying an outdated pattern. Preserve its public behavior and compatible contracts when changing it, but make new or touched code follow this skill where practical.

Ask the user only when complying would require a product-behavior decision, a public API change, a broad migration, or an architectural choice with more than one reasonable outcome. Do not ask merely because existing code uses a less suitable pattern.

Read the local Angular configuration and the closest component, service, template, and test before editing. Existing project facts that remain useful are the `apps/web` workspace, standalone components, `op-` selectors, SCSS component-generator default, signals, and Angular built-in control flow.

## Compose layouts with Flexbox first

Use Flexbox by default for component layout, alignment, spacing, responsive stacking, headers, toolbars, and card internals. For this application, maintainability outweighs micro-optimizing Flexbox performance.

Use CSS Grid only when the content truly has two-dimensional tracks, such as a table-like matrix or a dashboard grid. Do not use absolute positioning for ordinary layout; reserve it for overlays, popovers, badges, and other positioned UI.

Keep layout ownership local: a component owns the layout of its template, while the parent controls only the component's placement and size contract.

## Build components, not one-off markup

Before adding a large template section, look for an existing component under `apps/web/src/app/components`. If the interaction or visual pattern is reused, likely to be reused, or has a clear boundary, encapsulate it as an `op-` component instead of duplicating markup and styles.

No UI library is mandated. Build small, focused shared primitives in this repository when they remove repeated markup or behavior. Do not introduce a UI-library dependency for a single primitive, and do not create an abstraction for a genuinely one-off fragment.

Keep presentational components focused on typed inputs, outputs, and rendering. Keep API calls, cross-page workflow state, and orchestration in Angular services or feature containers rather than burying them in reusable UI components.

Create new components through Angular CLI from `apps/web`:

```bash
pnpm --dir apps/web exec ng generate component components/<name> --prefix=op --style=scss --standalone
```

Decide test generation in the context of the component. Keep the generated spec for behavior, accessibility, state, interaction, or non-trivial rendering. Pass `--skip-tests` only for a genuinely trivial presentational wrapper where a focused parent or feature test already covers the behavior. Do not set a global skip-test default.

Use a component-local template and stylesheet for normal components. Inline template or style only when the complete component is genuinely tiny, such as a small SVG icon or a style-free bridge component.

## Use Angular as Angular

Prefer standalone components and explicitly declare their template dependencies in `imports`. Use Angular signals for local and service-owned reactive state; derive values with `computed`, keep mutations close to their owning service or component, and avoid duplicating derivable state.

### Keep the application standalone and zoneless

Keep this Angular 22 application on the standalone and zoneless path. Angular v21+ runs zoneless by default, so do not add `provideZoneChangeDetection`, a `zone.js` polyfill/import, or code that depends on ZoneJS automatically scheduling change detection. The existing `zone.js` package declaration alone is not evidence that it is loaded; remove it only in a separately scoped dependency cleanup with build and test verification.

Use Angular's explicit change-detection notifications: update signals read by templates, use bound listeners, `AsyncPipe`, `ComponentRef.setInput`, or `ChangeDetectorRef.markForCheck()` when integrating an imperative or third-party callback. Do not rely on `NgZone.onStable`, `NgZone.onMicrotaskEmpty`, `NgZone.isStable`, or production calls to `detectChanges()` as routine synchronization. Use `afterNextRender` or `afterEveryRender` when work truly must follow rendering.

For new code, keep `bootstrapApplication` and standalone imports rather than reintroducing NgModules. Prefer `ChangeDetectionStrategy.OnPush` for application components; it is not mechanically required for zoneless operation, but it helps enforce compatible notification patterns. In tests, prefer waiting for Angular's scheduled update when practical instead of masking missing notifications with repeated `fixture.detectChanges()`.

Prefer signal-based `input()` and `output()` APIs for new component contracts. Keep compatible existing APIs when a migration would add churn without improving the changed behavior.

Use `@if` and `@for` in new templates. Always provide a stable `track` expression for domain collections; use an index only for a static, index-identified collection such as SVG shapes.

Use `@Injectable` services for API access, shared state, business workflow, and cross-component coordination. Scope a service deliberately: use `providedIn: 'root'` for app-wide state or a stateless shared client, and provide it at a feature/component boundary when its lifecycle must be local. Use Angular DI rather than manually creating collaborators or hiding state in module globals.

Create a directive when DOM behavior is shared across multiple components and does not deserve a visual component of its own. Use Angular lifecycle hooks, host bindings/listeners, renderer APIs, and CDK utilities when appropriate; do not reproduce framework behavior with ad-hoc global listeners or direct DOM manipulation. Do not create directives for one-off styling.

Use native semantic elements first. When a custom control is necessary, implement its keyboard behavior, focus handling, disabled state, accessible name, and relevant ARIA semantics.

Signals and template bindings should remain the normal update path.

## Keep SCSS scoped and tokenized

Write SCSS. Put resets, document-wide typography, shared keyframes, and truly global semantic tokens in `apps/web/src/styles.scss`. Put component layout and visual rules in that component's `styleUrl` SCSS file; use `:host` to establish the component's host-level display, sizing, or layout boundary when needed.

Do not add new broad component selectors to `app.scss` or global styles in order to style a component's internals. Do not use `::ng-deep` to bypass component encapsulation.

Use CSS custom properties for semantic values shared across components or likely to vary by theme/runtime, for example `--op-color-surface`, `--op-color-text`, `--op-color-accent`, and `--op-space-*`. Use SCSS variables for file-local compile-time calculations and private local palettes. Introduce tokens when a value repeats or represents a semantic role; do not perform a repository-wide color rewrite solely to introduce a token.

Prefer `gap`, alignment, and flex sizing over margin-based layout chains. Keep responsive rules with the owning component and use logical, semantic class names rather than styling DOM position.

### Introduce Tailwind through PostCSS deliberately

Tailwind is allowed when its utilities make a component clearer or remove repeated low-level CSS. Keep component boundaries and semantic templates: use utilities for local layout and simple presentation, but extract a component or scoped SCSS when class strings obscure structure, state, responsive behavior, or a reusable visual contract.

The current `apps/web` project has no Tailwind or PostCSS configuration. When introducing Tailwind, use Tailwind v4's PostCSS integration in the `apps/web` workspace:

```bash
pnpm --dir apps/web add -D tailwindcss @tailwindcss/postcss postcss
```

Create `apps/web/.postcssrc.json` with only the v4 plugin unless another plugin has a demonstrated need:

```json
{
  "plugins": {
    "@tailwindcss/postcss": {}
  }
}
```

Import Tailwind from the global SCSS entry point using Angular's SCSS form:

```scss
@use "tailwindcss";
```

Do not configure `tailwindcss` itself as a PostCSS plugin, use the removed v3 `@tailwind` directives, or add `postcss-import`/`autoprefixer` by habit: Tailwind v4 moved its PostCSS plugin to `@tailwindcss/postcss` and handles imports and vendor prefixing itself. Do not add a v3-style `tailwind.config.*` or manual `content` glob by default; v4 detects source files automatically. Use a Tailwind `@source` directive only when a required class source is outside automatic detection.

Tailwind v4's full import includes Preflight. Before enabling it, compare Preflight with `src/styles.scss` and preserve any intentional global base behavior. If Preflight conflicts with this app's reset or third-party widget styles, make an explicit, documented choice to adapt the global styles or import Tailwind's theme and utilities layers without Preflight; do not accept a visual regression as an installation side effect.

Use complete, statically detectable utility names in templates. Map dynamic variants to complete class strings rather than constructing class names at runtime. After installing or upgrading Tailwind, run a production build and visually verify a representative utility in an Angular template; this is the required PostCSS integration check.

## Verify the change

Add or retain focused tests when behavior changes. Run the narrowest relevant test first, then use the repository commands appropriate to the scope:

```bash
CI=true pnpm --dir apps/web test
CI=true pnpm --dir apps/web build
```

For a visual change, inspect the affected component at narrow and normal desktop widths and check keyboard navigation for interactive controls. Report any intentionally skipped test or verification and the reason.
