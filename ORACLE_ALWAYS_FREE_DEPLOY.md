Oracle Always Free Deployment
=============================

This guide is for the current Rahul Prints app on an Oracle Cloud Always Free VM.

Why this host fits the app
--------------------------

- Your app stores orders in `data/orders.json`, so a normal VM is a better fit than an ephemeral free web host.
- Oracle Cloud Always Free still includes free VM compute and block storage for the life of the account, subject to their current limits and idle-resource policies.

Recommended VM choice
---------------------

- Image: Ubuntu
- Shape: `VM.Standard.A1.Flex` if available as Always Free
- Size: 1 OCPU / 6 GB RAM is a good starting point
- Public IPv4: enabled

Oracle setup in the Console
---------------------------

1. Create an Always Free VM in your home region.
2. Open inbound ports `80` and `443` in the subnet security list or network security group.
3. Keep `22` open for SSH.
4. Copy the VM's public IP.

SSH from Windows PowerShell
---------------------------

```powershell
ssh -i C:\path\to\your-private-key ubuntu@YOUR_VM_PUBLIC_IP
```

If you use Oracle Linux instead of Ubuntu, the default user is usually `opc`.

Install system packages
-----------------------

```bash
sudo apt update
sudo apt install -y git nginx python3 python3-venv python3-pip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
python3 --version
```

Clone the app
-------------

```bash
cd /opt
sudo git clone https://github.com/rahulprints19-hash/rahul-prints.git rahul-prints
sudo chown -R $USER:$USER /opt/rahul-prints
cd /opt/rahul-prints
```

Create the app environment
--------------------------

```bash
cp .env.example .env
nano .env
```

Use these important values in `.env`:

```dotenv
HOST=127.0.0.1
PORT=3000
MAIL_PROVIDER=smtp
SMTP_USER=your_gmail_address
SMTP_PASS=your_rotated_gmail_app_password
```

Also fill in:

- `BUSINESS_NAME`
- `BUSINESS_EMAIL`
- `ORDER_NOTIFICATION_EMAIL`
- `BUSINESS_PHONE`
- `UPI_ID`

If you prefer Mailjet instead of Gmail SMTP on Oracle:

```dotenv
MAIL_PROVIDER=mailjet
MAIL_FROM_EMAIL=your_verified_sender
MAIL_FROM_NAME=Rahul Prints
MJ_APIKEY_PUBLIC=your_mailjet_public_key
MJ_APIKEY_PRIVATE=your_mailjet_private_key
```

Install app dependencies
------------------------

```bash
npm ci --omit=dev
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
deactivate
```

Point the app to the venv Python
--------------------------------

Add this line to `.env`:

```dotenv
PYTHON_EXECUTABLE=/opt/rahul-prints/.venv/bin/python
```

Test once before background service
-----------------------------------

```bash
npm start
```

Then open:

- `http://YOUR_VM_PUBLIC_IP`

If it works, stop it with `Ctrl+C`.

Install systemd service
-----------------------

The repo includes `deploy/oracle/rahul-prints.service`.

If you are on Ubuntu, run:

```bash
sudo cp deploy/oracle/rahul-prints.service /etc/systemd/system/rahul-prints.service
sudo systemctl daemon-reload
sudo systemctl enable --now rahul-prints
sudo systemctl status rahul-prints
```

If you chose Oracle Linux, edit the service file first and change:

- `User=ubuntu` to `User=opc`

Useful logs:

```bash
sudo journalctl -u rahul-prints -n 100 --no-pager
sudo journalctl -u rahul-prints -f
```

Install Nginx reverse proxy
---------------------------

The repo includes `deploy/oracle/rahul-prints.nginx.conf`.

On Ubuntu:

```bash
sudo cp deploy/oracle/rahul-prints.nginx.conf /etc/nginx/sites-available/rahul-prints
sudo ln -s /etc/nginx/sites-available/rahul-prints /etc/nginx/sites-enabled/rahul-prints
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

Now the app should open at:

- `http://YOUR_VM_PUBLIC_IP`

Optional HTTPS with a domain
----------------------------

If you have a domain, point an `A` record to the VM's public IP and then run:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Persistence and updates
-----------------------

- Your orders stay on the VM in `/opt/rahul-prints/data/orders.json`.
- Before updates, back up the `data/` folder.

Update flow:

```bash
cd /opt/rahul-prints
git pull
npm ci --omit=dev
. .venv/bin/activate
pip install -r requirements.txt
deactivate
sudo systemctl restart rahul-prints
```

Important Oracle free-tier notes
--------------------------------

- Oracle says Always Free compute instances can be reclaimed if they stay idle for 7 days under low CPU, memory, and network usage.
- Oracle blocks outbound TCP port `25` by default. Gmail SMTP through authenticated submission ports is usually the safer path than running your own mail server.

Go-live checklist
-----------------

1. Confirm the app opens from the VM public IP.
2. Upload a test PDF.
3. Test both original and B/W PDF flows.
4. Complete one real end-to-end email test.
5. Back up `/opt/rahul-prints/data/orders.json`.
