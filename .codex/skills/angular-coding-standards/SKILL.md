---
name: angular-coding-standards
description: Implement, review, or refactor Optipass Angular frontend code according to the repository's component, layout, SCSS, service, directive, and testing conventions. Use for changes under apps/web, especially when creating Angular components, shared UI primitives, templates, styles, stateful services, or directives. Treat the user-defined standards in this skill as authoritative even when older code differs.
---

# Optipass Angular Coding Standards

## Apply the standard over legacy code

Treat this skill as the normative rule set. Existing code may predate it and must not justify copying an outdated pattern. Preserve its public behavior and compatible contracts when changing it, but make new or touched code follow this skill where practical.

Ask the user only when complying would require a product-behavior decision, a public API change, a broad migration, or an architectural choice with more than one reasonable outcome. Do not ask merely because existing code uses a less suitable pattern.

Read the local Angular configuration and the closest component, service, template, and test before editing. Existing project facts that remain useful are the `apps/web` workspace, standalone components, `op-` selectors, SCSS component-generator default, signals, and Angular built-in control flow.

## Follow the bppleman code style

Treat `docs/bppleman.xml` as the only formatting authority for this project. Do not enable, invoke, or use `.prettierrc` or `.editorconfig` to decide formatting; retain those files untouched as legacy configuration. Use the IDE code scheme when available.

Apply this style to new and touched TypeScript, JavaScript, HTML, CSS, and SCSS. Do not mass-reformat unrelated legacy files solely to make the repository uniform.

Use four spaces for every indentation level and continuation indentation. Treat 160 columns as a soft margin: keep lines within it when practical, but break earlier whenever that makes a declaration, template, or expression easier to read.

### TypeScript and JavaScript

Use double-quoted strings, semicolons, and trailing commas for multiline literals, parameters, and calls. Use spaces inside object-literal and named-import braces, and inside template interpolation expressions: `{ value }`, `import { Component }`, and `${ value }`.

Sort imports by module name. Keep type-only imports explicit when TypeScript permits it. Indent chained calls as one visual group instead of aligning each continuation independently.

Write an explicit `public` modifier for public class members and methods. Preserve logical member grouping: keep properties with their getter/setter, treat lambda-initialized fields as methods for placement, and keep overridden methods together. Do not reorder declarations that already form a coherent local group merely to satisfy a mechanical order.

### HTML, CSS, and SCSS

Use four spaces in Angular templates and stylesheets. Place a space after `//` and inside block comments. Keep comments at their local indentation rather than forcing them to column zero.

Write quoted CSS and SCSS string values. Use uppercase, long-form hexadecimal colors such as `#AABBCC`; do not introduce shorthand or lowercase hexadecimal values. Align adjacent CSS/SCSS declaration values only when the group remains easy to scan, and do not add alignment padding to isolated declarations or across unrelated blocks.

## Compose layouts with Flexbox first

Use Flexbox by default for component layout, alignment, spacing, responsive stacking, headers, toolbars, and card internals. For this application, maintainability outweighs micro-optimizing Flexbox performance.

Use CSS Grid only when the content truly has two-dimensional tracks, such as a table-like matrix or a dashboard grid. Do not use absolute positioning for ordinary layout; reserve it for overlays, popovers, badges, and other positioned UI.

Keep layout ownership local: a component owns the layout of its template, while the parent controls only the component's placement and size contract.

## Build components, not one-off markup

Keep `app/` root limited to bootstrap and composition files such as the root component, routes, and application config. Do not flatten application components, services, directives, pipes, or guards beside those files.

Organize new frontend code by scope:

```text
app/
  core/                 # app-wide services, HTTP infrastructure, guards, interceptors, tokens
  shared/
    ui/                 # reusable, business-agnostic UI components
    directives/         # reusable Angular directives
    pipes/              # reusable Angular pipes
  features/<feature>/
    <feature>.page.*    # feature entry/page and feature route composition
    components/         # UI that only belongs to this feature
    data-access/        # feature-specific API/data services
    state/              # feature facade/store and feature workflow services
    directives/         # directives local to the feature, when needed
    pipes/              # pipes local to the feature, when needed
```

Place a component in `shared/ui/` only when it is business-agnostic and reusable across features. Place a page and its business-specific child components under its `features/<feature>/` boundary; do not put them into one global `components/` directory merely because they are Angular components. Keep a generic component generic: it must not inject a feature service or encode a feature's domain rules.

No UI library is mandated. Build small, focused shared primitives in this repository when they remove repeated markup or behavior. Do not introduce a UI-library dependency for a single primitive, and do not create an abstraction for a genuinely one-off fragment.

Keep presentational components focused on typed inputs, outputs, and rendering. Keep API calls, feature workflow state, and orchestration in the service/facade inside the same feature boundary rather than burying them in reusable UI components.

Make feature boundaries service boundaries. Put app-wide concerns such as session/bootstrap, shared HTTP infrastructure, global configuration, and cross-feature policies in `core/`. Put scan, analysis, execution, or any other business workflow in its owning feature's `data-access/` and `state/` services. Do not extend a single root service into an application-wide workflow manager; split new work by feature, and extract only the touched feature from a legacy broad service when a change makes the boundary clear.

Place Angular-specific constructs in their scope's dedicated directory. A directive or pipe reused by multiple features belongs under `shared/`; one that encodes feature behavior belongs under that feature. Apply the same scoping rule to guards, interceptors, tokens, and providers rather than leaving them flat in `app/`.

Create new components through Angular CLI from `apps/web`:

```bash
pnpm --dir apps/web exec ng generate component <scope>/<path>/<name> --prefix=op --style=scss --standalone
```

Choose `<scope>` as `shared/ui` for a reusable primitive or `features/<feature>/components` for a business-specific child. Generate pages, services, directives, and pipes into the same scope rather than manually creating files at the app root.

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

### Use RxJS only with an explicit data flow

Use RxJS when it makes an asynchronous or event-driven flow clearer: composing `HttpClient` requests, route or form events, debounced user input, cancellation, retries, SSE/WebSocket-like streams, or controlled concurrency. Do not wrap simple local state in observables when a signal is clearer, and do not force an existing promise or callback flow into RxJS without a concrete composition benefit. Converting a single `HttpClient` result with `firstValueFrom` at an imperative service-command boundary is acceptable; do not use it for a stream that must remain cancellable or react to more than one emission.

Before writing a pipeline, make its flow auditable: name the source, identify every transformation, define its error path, cancellation or completion owner, and final consumer. Keep the pipeline in the service or feature boundary that owns the data; components should consume a typed observable through `AsyncPipe` or convert it once at the UI boundary with `toSignal`, including an intentional initial value.

Choose flattening operators by business semantics and make the choice visible in the code:

- Use `switchMap` when only the latest request may affect the UI, such as search or filter changes.
- Use `concatMap` when side effects must execute in order.
- Use `exhaustMap` when a repeated action must be ignored while the first submission is active.
- Use `mergeMap` only for independent concurrent work; set a concurrency limit when the source can fan out.

Avoid nested `subscribe` calls and `Subject`-as-global-event-bus designs. Keep subjects private, expose readonly observables, and use a descriptive name that communicates whether the value is an event, state, command, or result. Tie every long-lived subscription to its lifecycle with `AsyncPipe`, `takeUntilDestroyed`, or an equally explicit owner. Do not swallow errors with an unexplained `EMPTY`; map them to an intentional UI/domain state or rethrow them to the owning boundary.

When combining RxJS and signals, keep one authoritative state owner. Use `toObservable` only when a signal must participate in a real stream pipeline, and avoid signal-to-observable-to-signal loops. Test cancellation, concurrency, completion, and error behavior when the pipeline has any of those semantics.

Use `@Injectable` services for API access, shared state, business workflow, and cross-component coordination. Scope a service deliberately: use `providedIn: 'root'` for app-wide state or a stateless shared client, and provide it at a feature/component boundary when its lifecycle must be local. Use Angular DI rather than manually creating collaborators or hiding state in module globals.

Create a directive when DOM behavior is shared across multiple components and does not deserve a visual component of its own. Use Angular lifecycle hooks, host bindings/listeners, renderer APIs, and CDK utilities when appropriate; do not reproduce framework behavior with ad-hoc global listeners or direct DOM manipulation. Do not create directives for one-off styling.

Use native semantic elements first. When a custom control is necessary, implement its keyboard behavior, focus handling, disabled state, accessible name, and relevant ARIA semantics.

Signals and template bindings should remain the normal update path.

## Keep SCSS scoped and tokenized

Write SCSS. Put resets, document-wide typography, shared keyframes, and truly global semantic tokens in `apps/web/src/styles.scss`. Put a component's layout and visual rules in its own `styleUrl` SCSS file, inside Angular's host style boundary. Use `:host` to establish the component's display, sizing, and layout boundary when needed; let ordinary descendant rules style only the component's own template.

Treat style leakage beyond a component host as an explicit exception, never the default. A small escape is acceptable only when its reason is specific and local, such as browser scrollbar styling, an overlay rendered outside the component tree, or a documented third-party component workaround. Target the narrowest external selector and place a nearby comment that identifies the escape target and reason.

Keep a host escape in the component stylesheet when it belongs to that component; use a minimal documented global rule only when the target truly lives outside every relevant component host, such as a document-level overlay container. `::ng-deep` is allowed only for a necessary third-party/internal-style workaround with that same reason comment and narrow selector. Do not add broad component selectors to `app.scss` or global styles merely to style component internals.

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

For a visual change, inspect the affected component at narrow and normal desktop widths and check keyboard navigation for interactive controls. For formatting-only work, compare the touched code against `docs/bppleman.xml` and run `git diff --check`; do not invoke Prettier or EditorConfig as validation. Report any intentionally skipped test or verification and the reason.
