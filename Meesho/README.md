# Meesho Data Downloader by SpeedEcom

A Chrome browser extension for bulk-downloading Meesho Supplier Orders, Payments, Returns, and Claims data for any date range as a single ZIP file, using your own logged-in session.

## 🎯 Features

- **Bulk Download** — Download Orders, Payments, Returns, and Claims data in one ZIP
- **Custom Date Ranges** — Select any date range up to 31 days
- **Quick Select Presets** — One-click filters: "This Month", "Last Month", "Last 30 Days"
- **Data Validation** — Verifies downloaded file data matches your selected filter before creating ZIP
- **Download History** — View recent downloads with auto-expiring 30-minute history
- **Session-Based** — Uses your existing Meesho login (no additional credentials)
- **Organized Output** — Files are automatically named with supplier ID, date range, and dataset type

## 📥 Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `production` folder
6. The extension icon will appear in your toolbar

## 🚀 Usage

### First Time Setup
1. Click the SpeedEcom extension icon
2. Enter your Speed Ecom account email and password
3. Click **Login**

### Downloading Data

1. Open your [Meesho Supplier Dashboard](https://supplier.meesho.com)
2. Click the SpeedEcom extension icon
3. Select your date range:
   - Use **Quick Select** chips for common ranges
   - Or click dates on the calendar for custom ranges (max 31 days)
4. Choose which datasets to download:
   - ✅ Orders (CSV)
   - ✅ Payments (Excel)
   - ✅ Returns (CSV)
   - ✅ Claims (CSV) — 6-month lookback
5. Click **Sync Now**
6. Extension will:
   - Request exports from Meesho
   - Download generated files
   - **Validate data matches your filter** (NEW!)
   - Create a ZIP file
   - Save to `Downloads/MeeshoSync/`

### Data Validation

The extension now validates downloaded data **before creating the ZIP**:

✅ **What is checked:**
- Date range in data matches selected filter
- Data doesn't extend beyond requested range
- All expected columns exist
- Files are not empty

❌ **If validation fails:**
- Sync stops with a clear error message
- No ZIP is created
- Shows exactly what went wrong (e.g., "Data extends beyond filter")

**Exception:** Claims files skip date validation (Claims always return 6 months — this is expected)

## 📁 File Structure

```
production/
├── manifest.json           # Extension metadata & permissions
├── popup.html              # UI for date/dataset selection
├── popup.js                # UI logic & date range handling
├── background.js           # Core sync logic & data validation
├── content.js              # Content script (unused, for future use)
├── jszip.min.js            # ZIP creation library
├── icon.png                # Extension icon
├── icons/                  # Icon assets (16px, 32px, 48px, 128px)
└── README.md              # This file
```

## 🔧 How It Works

### Authentication Flow
1. User enters email + password
2. Extension fetches Meesho's public RSA key
3. Encrypts password with RSA-OAEP
4. Posts encrypted credentials to Speed Ecom auth endpoint
5. Receives JWT token, stored in Chrome storage
6. Token used for all subsequent requests

### Sync Flow
1. **Initiate** — User clicks "Sync Now" with selected dates/datasets
2. **Request** — Extension requests exports from Meesho API
3. **Poll** — Waits for Meesho to generate files (5-60 seconds)
4. **Validate** ⭐ **NEW** — Validates downloaded data matches filter
5. **Bundle** — Creates ZIP with all CSV/Excel files
6. **Download** — Saves ZIP to Downloads folder
7. **History** — Records download with 30-minute expiry

### Data Validation (NEW)

**When:** After files are downloaded, before ZIP is created

**What happens:**
1. For each CSV file: Extract headers and scan rows
2. Identify date column (looks for: date, created, order_date, payment_date)
3. Find minimum and maximum dates in the data
4. Compare to user's selected date range
5. If mismatch detected → Stop and show error
6. If all valid → Proceed to ZIP creation

**Example:**
```
User selected: July 1-31, 2026
Orders data has: July 5-31, 2026 ✅ VALID
Payments data has: Jan 1 - July 31, 2026 ❌ INVALID (too much data)

Error: "Data extends beyond filter (2026-01-01 vs 2026-07-01)"
Result: ZIP not created, sync fails
```

## 🔐 Security & Privacy

- ✅ All data stays in your browser (no server-side processing)
- ✅ Password encrypted with RSA before transmission
- ✅ JWT token stored locally, never shared
- ✅ No tracking or analytics
- ✅ No data collection

## 🛠️ Development

### Adding Features

To add validation for Excel files:
1. Implement `parseExcelMetadata()` in `background.js`
2. Update file type detection in `extractFileMetadata()`
3. Test with real Excel files from Meesho

To modify validation rules:
1. Edit `validateFileData()` function
2. Adjust date column detection in `parseCSVMetadata()`
3. Add/remove validation checks in validation loop

### Debugging

Enable console logs to see validation details:
1. Right-click extension icon → Inspect
2. Click "Service Worker" link
3. View console for validation results: `[meesho-sync:bg] Validation result: {...}`

## 📊 Technical Details

### Key Constants
- `MAX_OFFSET_DAYS = 31` — Maximum date range
- `CLAIMS_LOOKBACK_MONTHS = 6` — Claims always 6-month lookback
- `HISTORY_TTL_MIN = 30` — Download history expires after 30 minutes
- `MIN_YEAR = 2012` — Earliest year available in date picker

### Dependencies
- **jszip.min.js** — Creates ZIP files from ArrayBuffers
- **Chrome APIs**: tabs, storage, downloads, runtime, alarms, declarativeNetRequest

### Browser Support
- Chrome/Chromium 88+ (Manifest V3)

## 🐛 Troubleshooting

### "Open your Meesho dashboard tab first"
- You need to have the Meesho dashboard open in a tab
- Make sure you're logged in to Meesho

### "Could not read your supplier ID"
- Reload the Meesho dashboard page
- Log in again if needed
- Try syncing again

### "Data validation failed: Orders: Data extends beyond filter"
- The API returned more data than your filter requested
- Try selecting a different date range
- Contact support if issue persists

### Zip file not downloading
- Check Chrome downloads settings (should auto-download to ~/Downloads)
- Disable download prompts in Chrome settings
- Check extension has "downloads" permission

## 📝 Logs & History

- **Download History** — View in extension popup (30-minute expiry)
- **Browser Console** — Service Worker logs (right-click icon → Inspect)
- **Chrome Downloads** — All ZIP files in Downloads/MeeshoSync/

## 📞 Support

For issues or feature requests, contact Speed Ecom support or check the extension logs.

---

**Version:** 1.2.0  
**Last Updated:** July 2026  
**Created by:** Speed Ecom Solutions
