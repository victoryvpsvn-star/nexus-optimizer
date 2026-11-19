# NEXUS - lay link ISO Win11 24H2 chinh chu Microsoft KHONG qua Fido
# Flow giong Fido.ps1 (pbatard) phien ban sau: whitelist session -> ov-df mdt.js
# -> reply -> getskuinformationbyproductedition -> GetProductDownloadLinksBySku
import json, re, sys, time, uuid
import http.cookiejar
import urllib.request, urllib.error

LOG = []
def log(m):
    s = str(m)
    LOG.append(s)
    print(s, flush=True)

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
opener.addheaders = [
    ('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    ('Referer', 'https://www.microsoft.com/software-download/windows11'),
]

def GET(url):
    try:
        with opener.open(urllib.request.Request(url), timeout=40) as r:
            return r.status, r.read().decode('utf-8-sig', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8-sig', 'replace')
    except Exception as e:
        return -1, str(e)

ORG_ID = 'y6jn8c31'
INSTANCE = '560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175'
PROFILE = '606624d44113'
EDITION = '3813'  # Windows 11 Home/Pro/Edu multi-edition (non-China)
LOCALE = 'en-US'  # vi-VN khong duoc ho tro boi connector (0 Sku) - ISO en-US, doi UI tieng Viet sau khi cai

sid = str(uuid.uuid4())
log('session: ' + sid)

# 1. Whitelist session qua vlscppe tags
st, _ = GET('https://vlscppe.microsoft.com/tags?org_id=%s&session_id=%s' % (ORG_ID, sid))
log('[1] vlscppe tags: %s' % st)

# 2. mdt.js -> w + rticks
st, body = GET('https://ov-df.microsoft.com/mdt.js?instanceId=%s&PageId=si&session_id=%s' % (INSTANCE, sid))
log('[2] mdt.js: %s (%d bytes)' % (st, len(body)))
mw = re.search(r'[?&]w=([A-F0-9]+)', body)
mr = re.search(r'rticks="?\\?"\+?(\d+)', body) or re.search(r'rticks\D{0,4}(\d{6,})', body)
if not mw or not mr:
    log('mdt.js snippet: ' + body[:600])
    print('NEXUS-MS-CONNECTOR-FAIL', flush=True)
    sys.exit(1)
w, rt = mw.group(1), mr.group(1)
log('    w=%s... rticks=%s' % (w[:16], rt))

# 3. Reply ov-df voi session + epoch + w/rticks
mdt = int(time.time() * 1000)
st, _ = GET('https://ov-df.microsoft.com/?session_id=%s&CustomerId=%s&PageId=si&w=%s&mdt=%d&rticks=%s'
            % (sid, INSTANCE, w, mdt, rt))
log('[3] ov-df reply: %s' % st)

# 4. SKU info cho edition 3813 (thu lai 3 lan nhu Fido)
d = None
for attempt in range(3):
    st, body = GET('https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition'
                   '?profile=%s&productEditionId=%s&SKU=undefined&friendlyFileName=undefined&Locale=%s&sessionID=%s'
                   % (PROFILE, EDITION, LOCALE, sid))
    log('[4] getskuinformation (lan %d): %s' % (attempt + 1, st))
    try:
        d = json.loads(body)
    except Exception as e:
        log('    json err: %s | %s' % (e, body[:200]))
        time.sleep(2)
        continue
    if d.get('Errors'):
        log('    api errors: ' + json.dumps(d['Errors'])[:300])
        time.sleep(2)
        continue
    break
if not d or not d.get('Skus'):
    print('NEXUS-MS-CONNECTOR-FAIL', flush=True)
    sys.exit(1)
skus = d['Skus']
log('    %d sku, ngon ngu co: %s' % (len(skus), ', '.join(sorted(set(s.get('Language', '?') for s in skus))[:8])))

sku = next((s for s in skus if (s.get('Language') or '') == 'English'), None) or skus[0]
skuid = sku.get('Id') or sku.get('SkuId')
log('    chon SKU: %s (%s) Id=%s' % (sku.get('Language'), sku.get('LocalizedLanguage'), skuid))

# 5. Link download
st, body = GET('https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku'
               '?profile=%s&productEditionId=undefined&SKU=%s&friendlyFileName=undefined&Locale=%s&sessionID=%s'
               % (PROFILE, skuid, LOCALE, sid))
log('[5] GetProductDownloadLinksBySku: %s' % st)
try:
    d = json.loads(body)
except Exception as e:
    log('    json err: %s | %s' % (e, body[:300]))
    print('NEXUS-MS-CONNECTOR-FAIL', flush=True)
    sys.exit(1)
if d.get('Errors'):
    log('    api errors: ' + json.dumps(d['Errors'])[:400])
    print('NEXUS-MS-CONNECTOR-FAIL', flush=True)
    sys.exit(1)
opts = d.get('ProductDownloadOptions') or []
log('    %d option(s):' % len(opts))
for o in opts:
    log('      %s -> %s' % (o.get('DownloadType'), (o.get('Uri') or '')[:100]))

uri = None
for o in opts:
    u = o.get('Uri') or ''
    dt = str(o.get('DownloadType', ''))
    if dt.lower() in ('x64', '1') and u.lower().endswith('.iso'):
        uri = u
        break
if not uri and opts:
    for o in opts:
        u = o.get('Uri') or ''
        if u.lower().endswith('.iso'):
            uri = u
            break
if not uri:
    print('NEXUS-MS-CONNECTOR-FAIL', flush=True)
    sys.exit(1)
print('NEXUS-ISO-URL=' + uri, flush=True)
print('NEXUS-MS-CONNECTOR-OK', flush=True)
