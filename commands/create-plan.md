Interactive plan creation workflow that gathers context and creates a detailed implementation plan through parallel research.

## Phase 1: Context Gathering
1. Read all user-provided context files completely
2. Ask clarifying questions about requirements
3. Identify unknowns that need investigation

## Phase 2: Parallel Research
Use the **research-orchestrator** agent to coordinate investigation:
- This agent will spawn specialized research agents in parallel
- It will synthesize findings and present a unified research report
- Wait for the research report before proceeding to planning

### For UI-Related Features
If the feature involves UI/frontend work (detected via keywords, file paths, or Linear labels), include **design context discovery** in the research scope:

**Run design context discovery**:
```bash
# Gather design context using HOK-806 utility
npx tsx tools/gather-review-context.ts main | jq '.designContext' > /tmp/design-context.json

# Review discovered artifacts
cat /tmp/design-context.json
```

**Include in research scope**:
1. **Tailwind Config Theme**
   - Colors (theme.colors.*)
   - Spacing scale (theme.spacing.*)
   - Typography (theme.fontFamily.*, theme.fontSize.*)
   - Custom theme extensions

2. **Component Library**
   - Library name and version (Radix UI, Headless UI, Material UI, Ant Design, shadcn/ui)
   - Available components
   - Usage patterns from existing code

3. **Design Guides**
   - DESIGN.md or STYLE-GUIDE.md content
   - Component patterns and conventions
   - Layout guidelines
   - Accessibility requirements

4. **CSS Variables & Design Tokens**
   - :root custom properties
   - Design token files (tokens.json, design-tokens.json)
   - Color palettes and naming conventions

5. **Storybook Configuration** (if available)
   - Available stories
   - Component documentation
   - Visual testing setup

**Present design context in research report**:
```markdown
### Design Context
**Component Library**: Radix UI v1.0.0
- Available components: Accordion, Dialog, Select, Dropdown, Toast, etc.
- Usage pattern: Import from @radix-ui/react-*

**Tailwind Theme**:
- Colors: Custom primary/secondary palette in theme.colors
- Spacing: 8px base scale (theme.spacing)
- Fonts: Inter (sans), JetBrains Mono (mono)

**Design Guide**: docs/DESIGN.md exists
- Component structure: /components/<name>/<Name>.tsx
- Naming: PascalCase components, kebab-case files
- Props: Use TypeScript interfaces, export PropTypes

**Storybook**: Configured (.storybook directory found)
- Stories available for: Button, Card, Modal, Navigation
- Run with: npm run storybook

**CSS Variables**: :root block in styles/globals.css
- Color vars: --color-primary, --color-secondary, --color-background
- Spacing: --spacing-unit (8px base)
```

**Detection**: Run design context discovery if the feature:
- Mentions UI keywords (component, page, design, styling, responsive, layout)
- Touches UI files (*.tsx, *.jsx, *.css, *.scss, *.html)
- Has "Layer: UI" label in Linear
- Modifies frontend code paths

## Phase 3: Research Synthesis
1. Review findings from all research agents
2. Identify gaps between requirements and current state
3. Document assumptions and risks
4. Confirm understanding with user before planning

## Phase 4: Plan Structure
Create a structured implementation plan with:
- **Overview**: What are we building and why
- **Current State**: What exists today (from research)
- **Design Context** (for UI features - include if design context was gathered in Phase 2):
  - Tailwind theme constraints (colors, spacing, fonts to use)
  - Component library patterns to follow (e.g., "Use Radix UI Dialog for modals")
  - Design guide requirements (e.g., "Follow component structure from docs/DESIGN.md")
  - Responsive breakpoints (e.g., "Mobile: <640px, Tablet: 640-1024px, Desktop: >1024px")
  - CSS variables to use (e.g., "Use --color-primary for brand color")
  - Accessibility requirements (e.g., "All interactive elements need aria-labels")
- **Proposed Changes**: What will change
- **Implementation Phases**: Break work into 3-5 phases
  - Each phase should be independently testable
  - Define clear completion criteria
  - Identify dependencies between phases
  - **For UI features**, add UI-specific phases when appropriate:
    - **Phase X: Component Structure** - Set up component files and basic structure
    - **Phase Y: Visual Implementation** - Build UI according to design specs (layout, styling, colors)
    - **Phase Z: Interactive Behavior** - Add click handlers, form logic, state management
    - **Phase W: Responsive Testing** - Verify and fix behavior at all breakpoints
    - **Phase V: Design Standards Compliance** - Ensure adherence to Tailwind theme, component library, design guide
- **Success Criteria**:
  - Automated checks (tests, linting, builds)
  - Manual verification steps
  - **UI-specific criteria** (for UI features):
    - Visual acceptance criteria (what the UI should look like)
    - Console expectations (clean console or acceptable warnings)
    - Responsive behavior (works at mobile, tablet, desktop breakpoints)
    - Design standards compliance (follows Tailwind theme, component library patterns)
    - Accessibility checks (keyboard navigation, screen reader support)
- **Out of Scope**: What we're explicitly NOT doing

## Phase 5: Plan Review
1. Present plan structure to user
2. Get feedback and refine
3. Save final plan to `features/<feature-name>/plan.md`
4. Ask user to approve before proceeding to implementation

## Key Principles
- Be skeptical of requirements - ask "why" to understand true needs
- Investigate thoroughly before proposing solutions
- Work interactively - don't disappear for long periods
- Make plans specific and actionable, not vague
- Each phase should deliver value incrementally

## Example: UI Feature Plan Structure

Here's an example of what a plan for a UI feature might look like after incorporating design context:

```markdown
# Implementation Plan: Add User Profile Settings Page

## Overview
Building a new user profile settings page where users can update their avatar, display name, email preferences, and theme selection.

## Current State
- No dedicated settings page exists
- User data is managed via API at /api/users/:id
- Auth context provides current user info
- Design system uses Tailwind + Radix UI components

## Design Context
**Tailwind Theme**:
- Primary color: theme.colors.blue.600
- Spacing: 8px base scale (theme.spacing)
- Border radius: theme.borderRadius.lg (8px)
- Font: Inter (theme.fontFamily.sans)

**Component Library**: Radix UI v1.0.3
- Use Dialog for confirmation modals
- Use Switch for toggle controls
- Use Avatar component for profile pictures

**Design Guide** (docs/DESIGN.md):
- Form layout: Label above input, 16px gap
- Error states: Red text below field, shake animation
- Success feedback: Toast notification (Radix UI Toast)

**Responsive Breakpoints**:
- Mobile: < 640px (single column, full width)
- Tablet: 640-1024px (single column, max-width 600px)
- Desktop: > 1024px (two columns, max-width 800px)

**CSS Variables**:
- Use --color-background for page background
- Use --color-card for panel backgrounds

## Proposed Changes
- Create /settings route and page component
- Build form components for each settings section
- Integrate with existing /api/users/:id endpoint
- Add client-side validation
- Implement avatar upload to S3

## Implementation Phases

### Phase 1: Component Structure
- Create SettingsPage.tsx component
- Set up routing in app router
- Create section components (ProfileSection, PreferencesSection, ThemeSection)
- Add basic layout with Tailwind grid

**Success Criteria**:
- [ ] /settings route renders without errors
- [ ] Page structure matches design (header, sections, save button)
- [ ] No console errors

### Phase 2: Visual Implementation
- Apply Tailwind styling per design specs
- Integrate Radix UI Avatar component
- Add form inputs with labels
- Implement responsive grid (single/two column)

**Success Criteria**:
- [ ] Matches design guide (16px gap, proper borders, colors from theme)
- [ ] Avatar displays user image or initials fallback
- [ ] Form inputs use theme colors (blue.600 for focus state)
- [ ] Responsive: Works at 375px, 768px, 1440px viewports

### Phase 3: Interactive Behavior
- Add form state management (useState or form library)
- Implement save handler (PATCH /api/users/:id)
- Add validation (email format, name length)
- Show loading state during save
- Display success/error feedback

**Success Criteria**:
- [ ] Clicking Save sends PATCH request with updated data
- [ ] Validation errors appear below fields (red text)
- [ ] Success shows toast notification
- [ ] Save button disabled during loading

### Phase 4: Avatar Upload
- Add file input (hidden, triggered by avatar click)
- Upload to S3 via /api/upload endpoint
- Update user avatar URL
- Show upload progress

**Success Criteria**:
- [ ] Clicking avatar opens file picker
- [ ] Only JPEG/PNG accepted (max 5MB)
- [ ] Upload progress indicator visible
- [ ] Avatar updates immediately after upload

### Phase 5: Design Standards & Testing
- Review compliance with Tailwind theme
- Verify Radix UI component usage
- Test responsive breakpoints
- Check console for errors/warnings
- Validate accessibility (keyboard nav, aria-labels)

**Success Criteria**:
- [ ] Uses theme.colors.blue.600 (not hardcoded blue)
- [ ] Radix UI Dialog/Switch/Avatar used correctly
- [ ] Mobile/tablet/desktop layouts work smoothly
- [ ] Clean console (no errors, no warnings)
- [ ] Tab navigation works, Enter submits form
- [ ] Screen reader announces form fields and errors

## Success Criteria

**Functional**:
- [ ] User can update display name, email preferences, theme
- [ ] User can upload and change avatar
- [ ] Changes persist after page reload
- [ ] Validation prevents invalid data

**Visual**:
- [ ] Matches design guide layout and styling
- [ ] Uses Tailwind theme colors and spacing
- [ ] Responsive at all breakpoints
- [ ] Radix UI components integrated correctly

**Technical**:
- [ ] Clean console (no errors or warnings)
- [ ] Tests pass (unit tests for validation, integration tests for save flow)
- [ ] Lint passes
- [ ] Accessible (keyboard nav, screen reader support)

## Out of Scope
- Password change (separate security feature)
- Two-factor authentication setup
- Account deletion
- Email verification flow
```

---

## Output Location
Save the plan to: `features/<feature-name>/plan.md`

Next step: Use `/implement-plan` command to execute the plan with validation gates.
