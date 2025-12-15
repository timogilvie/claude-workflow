---
name: frontend-testing
description: Test web applications using Chrome DevTools. Use for visual regression testing, performance analysis, accessibility checks, console error detection, and automated UI testing. Works with live URLs or local development servers.
---

# Frontend Testing Skill

## Purpose
Automate frontend testing using Chrome DevTools Protocol to verify UI functionality, performance, and correctness.

## When to Use This Skill
- Testing UI components in a browser
- Checking for console errors or warnings
- Performance profiling of web pages
- Visual regression testing with screenshots
- Automated user flows (clicking, typing, form filling)
- Network request validation
- Accessibility testing

## Instructions

### 1. Basic Page Testing
1. Use `navigate_page` to load the target URL
2. Use `wait_for` to ensure page is ready (e.g., wait for specific elements)
3. Use `take_screenshot` to capture the current state
4. Use `list_console_messages` to check for errors or warnings

### 2. Performance Testing
1. Use `performance_start_trace` before loading the page
2. Navigate to the target URL
3. Use `performance_stop_trace` to capture metrics
4. Use `performance_analyze_insight` to get actionable insights

### 3. Interactive Testing
1. Use `click` to interact with buttons or links
2. Use `fill` or `fill_form` to test form inputs
3. Use `press_key` for keyboard interactions
4. Use `hover` to test hover states
5. Take screenshots after each interaction to verify state changes

### 4. Network Testing
1. Navigate to the page
2. Use `list_network_requests` to see all requests
3. Use `get_network_request` to inspect specific requests
4. Verify API responses, status codes, and timing

### 5. Multi-Page Testing
1. Use `new_page` to open additional tabs
2. Use `list_pages` to see all open tabs
3. Use `select_page` to switch between tabs
4. Use `close_page` when done

## Best Practices
- Always wait for page load before interacting (`wait_for`)
- Take screenshots before and after interactions for debugging
- Check console messages after page load to catch JavaScript errors
- Use meaningful filenames for screenshots (include timestamp or test name)
- Clean up by closing pages when tests are complete

## Common Testing Patterns

### Pattern: Basic Smoke Test
```
1. Navigate to URL
2. Wait for page load
3. Check console for errors
4. Take screenshot
5. Report results
```

### Pattern: Form Submission Test
```
1. Navigate to form page
2. Fill form fields using `fill_form`
3. Take screenshot of filled form
4. Click submit button
5. Wait for response/redirect
6. Verify success message or URL change
7. Check console for errors
```

### Pattern: Performance Audit
```
1. Start performance trace
2. Navigate to URL
3. Wait for page to fully load
4. Stop performance trace
5. Analyze trace for insights
6. Report metrics (LCP, FID, CLS, etc.)
```

## Example Usage
User: "Test the homepage at localhost:3000"
Response: Navigate, wait for load, check console, take screenshot, report findings

User: "Profile the performance of example.com"
Response: Start trace, navigate, stop trace, analyze, report metrics

User: "Test the login flow with credentials test@example.com / password123"
Response: Navigate to login, fill form, submit, verify redirect, check for errors
