# Frontend Testing Reference

## CSS Selector Patterns
- Buttons: `button`, `[role="button"]`, `.btn`, `input[type="submit"]`
- Forms: `form`, `input`, `select`, `textarea`
- Navigation: `nav`, `[role="navigation"]`, `.navbar`
- Main content: `main`, `[role="main"]`, `#content`
- Links: `a`, `[role="link"]`
- Images: `img`, `picture`
- Tables: `table`, `tbody`, `thead`, `tr`, `td`
- Lists: `ul`, `ol`, `li`
- Headers: `h1`, `h2`, `h3`, `h4`, `h5`, `h6`
- Dialogs/Modals: `dialog`, `[role="dialog"]`, `.modal`

## Common Wait Conditions
- `wait_for`: Wait for element to appear
- Use selector like `'button[type="submit"]'`
- Wait for network idle: `networkidle`
- Wait for specific state: `visible`, `hidden`, `stable`

## Screenshot Naming Convention
- Format: `{feature}-{state}-{timestamp}.png`
- Examples:
  - `login-form-filled-2024-01-15.png`
  - `homepage-initial-load.png`
  - `checkout-success-message.png`
  - `error-state-validation.png`

## Performance Metrics to Check
- **LCP (Largest Contentful Paint)**: Should be < 2.5s
- **FID (First Input Delay)**: Should be < 100ms
- **CLS (Cumulative Layout Shift)**: Should be < 0.1
- **TTI (Time to Interactive)**: Should be < 3.8s
- **TBT (Total Blocking Time)**: Should be < 200ms

## Console Error Types
- **Error**: JavaScript errors that break functionality
- **Warning**: Potential issues that don't break the app
- **Info**: Informational messages
- **Debug**: Debug logging (usually safe to ignore)

## Network Status Codes
- **2xx**: Success (200 OK, 201 Created, 204 No Content)
- **3xx**: Redirection (301 Moved, 302 Found, 304 Not Modified)
- **4xx**: Client errors (400 Bad Request, 401 Unauthorized, 404 Not Found)
- **5xx**: Server errors (500 Internal Server Error, 503 Service Unavailable)

## Common Test Assertions
- Element exists and is visible
- Text content matches expected value
- Form submission succeeds
- No console errors after page load
- Navigation redirects to correct URL
- API calls return expected status codes
- Images load successfully
- Performance metrics meet thresholds
