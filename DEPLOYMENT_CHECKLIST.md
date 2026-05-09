Rahul Prints Deployment Checklist
================================

1. Choose your free public host
   Fastest setup: Render
   Better long-term reliability for saved local files: Oracle Cloud Always Free VM

2. Install dependencies
   Run `npm install`

3. Create environment file
   Copy `.env.example` to `.env`

4. Configure email
   For local testing: set `MAIL_PROVIDER=smtp`
   Add your sender address to `SMTP_USER`
   Add the SMTP password or app password to `SMTP_PASS`
   Optional: use `SMTP_SERVICE` for Gmail, Outlook, or Zoho, or set `SMTP_HOST`, `SMTP_PORT`, and `SMTP_SECURE`
   For Render free deployment: set `MAIL_PROVIDER=mailjet`
   Keep `BUSINESS_EMAIL` / `ORDER_NOTIFICATION_EMAIL` as the inbox you want to receive replies and order alerts on
   Set `MAIL_FROM_EMAIL` to a verified custom-domain sender, not a Gmail/Hotmail/Yahoo address
   Add `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `MJ_APIKEY_PUBLIC`, and `MJ_APIKEY_PRIVATE`

5. Configure Razorpay and business details
   Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
   Confirm `BUSINESS_PHONE` and `BUSINESS_EMAIL`
   Optional: Set `ORDER_NOTIFICATION_EMAIL` if the print-desk email should differ from the public business email

6. Optional WhatsApp automation
   Set `WHATSAPP_PROVIDER=callmebot`
   Set `WHATSAPP_PHONE`
   Set `CALLMEBOT_API_KEY`

7. Optional local smoke testing
   Set `DRY_RUN_NOTIFICATIONS=true` if you want to verify the full order flow without sending real emails or WhatsApp messages

8. Start the app
   Use `npm start`

9. Test before going live
   Open `http://localhost:3000`
   Upload a sample file
   Tap `Pay Securely with Razorpay`
   Complete a sample payment in Razorpay test mode
   Verify PDF download works
   Verify both emails arrive
   Verify WhatsApp alert arrives if configured

10. Deploy on Render if you want the quickest public launch
   Push this project to GitHub
   Create a new Render Blueprint or Web Service from the repo
   If you use Blueprint sync, the included `render.yaml` is ready to use
   Render will prompt for the Razorpay and Mailjet values defined with `sync: false` in `render.yaml`
   Add any remaining values from `.env` if you customize them beyond the defaults in `render.yaml`
   Keep the health check path as `/api/health`

11. Important Render free-plan caveat
   Render free web services can sleep after inactivity
   Render free web services use ephemeral local storage, so `data/orders.json` is not reliable long-term on the free tier
   Render free blocks outbound SMTP ports, so use Mailjet or another HTTPS email API instead of Gmail SMTP
   Use Oracle Cloud Always Free VM if you want the current local-file storage model to behave more like a traditional always-on server

12. Production safety checks
   Keep `.env` private
   Rotate any old app passwords that were exposed
   Avoid committing secrets to source files
   Monitor your provider's sending limits if volume increases
