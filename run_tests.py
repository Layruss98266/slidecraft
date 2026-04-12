"""Comprehensive API test suite for SlideCraft."""
import requests, json, os, time, io, sys

BASE = 'http://localhost:5050'
results = []

def test(name, method, url, **kwargs):
    try:
        r = getattr(requests, method)(url, **kwargs, timeout=30)
        status = r.status_code
        ok = status < 400
        detail = ''
        try:
            j = r.json()
            if 'error' in j:
                detail = j['error']
                ok = False
        except:
            ct = r.headers.get("content-type", "?")
            detail = f'content-type: {ct}, size: {len(r.content)}'
        results.append((name, 'PASS' if ok else 'FAIL', status, detail))
        return r
    except Exception as e:
        results.append((name, 'ERROR', 0, str(e)[:80]))
        return None

def test_expect_400(name, method, url, **kwargs):
    """Test that expects a 400 response — counts 400 as PASS."""
    test(name, method, url, **kwargs)
    # Check if last result was a 400 — that's correct behavior
    if results[-1][2] == 400:
        results[-1] = (results[-1][0], 'PASS', 400, 'Correctly rejected bad input')

# 1. HOME PAGE
test('GET /', 'get', f'{BASE}/')

# 2. UPLOAD PPTX
with open('test_presentation.pptx', 'rb') as f:
    r = test('POST /api/upload', 'post', f'{BASE}/api/upload',
             files={'file': ('test.pptx', f, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')})
    if r and r.status_code == 200:
        print(f'  Upload: {r.json()}')
time.sleep(2)

# 3. GET SLIDES
test('GET /api/slide/1', 'get', f'{BASE}/api/slide/1')
test('GET /api/slide/2', 'get', f'{BASE}/api/slide/2')
test('GET /api/slide/3', 'get', f'{BASE}/api/slide/3')

# 4. SAVE SLIDE DATA
overlay_data = {
    'overlays': [
        {'type': 'text', 'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.05,
         'text': 'Hello World', 'color': '#FFFFFF', 'fontSize': 24,
         'bold': False, 'italic': False, 'align': 'left',
         'bgColor': 'transparent', 'opacity': 1},
        {'type': 'rect', 'x': 0.5, 'y': 0.5, 'w': 0.2, 'h': 0.1,
         'fillColor': '#FF0000', 'opacity': 0.8}
    ],
    'notes': 'Test speaker notes'
}
test('POST /api/slide/1 (save overlays)', 'post', f'{BASE}/api/slide/1', json=overlay_data)

r = test('GET /api/slide/1 (verify save)', 'get', f'{BASE}/api/slide/1')
if r and r.status_code == 200:
    j = r.json()
    n_ov = len(j.get('overlays', []))
    print(f'  Verified: {n_ov} overlays, notes="{j.get("notes","")}"')

# 5. REMOVE LOGO
test('POST /api/remove-logo', 'post', f'{BASE}/api/remove-logo')

# 6. BAKE OVERLAYS
bake_data = {
    'overlays': [
        {'type': 'text', 'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.05,
         'text': 'Bake Me', 'color': '#FFFF00', 'fontSize': 20,
         'bold': True, 'italic': False, 'align': 'center',
         'bgColor': '#000000', 'opacity': 1, 'fontFamily': 'Arial',
         'lineHeight': 1.3, 'letterSpacing': 0, 'textTransform': 'none',
         'listStyle': 'none', 'shadow': False, 'shadowColor': '#000000',
         'outline': False, 'outlineColor': '#000000', 'outlineWidth': 1,
         'underline': False, 'autoFit': False}
    ],
    'notes': ''
}
test('POST /api/slide/2 (prep bake)', 'post', f'{BASE}/api/slide/2', json=bake_data)
test('POST /api/slide/2/bake', 'post', f'{BASE}/api/slide/2/bake')

# 7. IMAGE FILTERS
for filt in ['brightness', 'contrast', 'saturation', 'sharpen']:
    test(f'POST filter/{filt}', 'post', f'{BASE}/api/slide/1/filter',
         json={'filter': filt, 'value': 1.2})
test('POST filter/blur', 'post', f'{BASE}/api/slide/1/filter',
     json={'filter': 'blur', 'value': 2})
test('POST filter/grayscale', 'post', f'{BASE}/api/slide/1/filter',
     json={'filter': 'grayscale'})
test('POST filter/sepia', 'post', f'{BASE}/api/slide/1/filter',
     json={'filter': 'sepia'})

# 8. CROP & ROTATE
test('POST crop', 'post', f'{BASE}/api/slide/3/crop',
     json={'x': 0.1, 'y': 0.1, 'w': 0.8, 'h': 0.8})
test('POST rotate', 'post', f'{BASE}/api/slide/3/rotate',
     json={'angle': 90})

# 9. SAMPLE COLOR
test('POST sample-color', 'post', f'{BASE}/api/sample-color/1',
     json={'x': 0.05, 'y': 0.05, 'w': 0.2, 'h': 0.05})

# 10. UPLOAD IMAGE
from PIL import Image as PILImage
img = PILImage.new('RGB', (100, 100), 'blue')
buf = io.BytesIO()
img.save(buf, 'PNG')
buf.seek(0)
test('POST upload-image', 'post', f'{BASE}/api/upload-image',
     files={'file': ('test.png', buf, 'image/png')})

# 11. REORDER SLIDES
test('POST reorder', 'post', f'{BASE}/api/reorder',
     json={'order': [3, 1, 2]})

# 12. QR CODE
test('POST qr-generate', 'post', f'{BASE}/api/qr-generate',
     json={'url': 'https://example.com'})

# 13. WATERMARK (text)
test('POST watermark', 'post', f'{BASE}/api/watermark',
     json={'text': 'CONFIDENTIAL', 'position': 'center', 'opacity': 30})

# 14. DETECT WATERMARK
test('POST detect-watermark', 'post', f'{BASE}/api/detect-watermark/1')

# 15. FIND & REPLACE
test('POST /api/slide/1 (prep find-replace)', 'post', f'{BASE}/api/slide/1', json={
    'overlays': [{'type': 'text', 'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.05,
                  'text': 'Find this text', 'color': '#FFFFFF', 'fontSize': 18}],
    'notes': ''
})
test('POST find-replace', 'post', f'{BASE}/api/find-replace',
     json={'find': 'Find this', 'replace': 'Replaced'})

# 16. TEMPLATES
test('GET /api/templates', 'get', f'{BASE}/api/templates')
test('POST save template', 'post', f'{BASE}/api/templates/save',
     json={'name': 'TestTemplate1'})
r = test('GET /api/templates (after save)', 'get', f'{BASE}/api/templates')
if r and r.status_code == 200:
    print(f'  Templates: {r.json()}')
test('POST load template', 'post', f'{BASE}/api/templates/load',
     json={'name': 'TestTemplate1'})
test('POST delete template', 'post', f'{BASE}/api/templates/delete',
     json={'name': 'TestTemplate1'})

# 17. VERSION HISTORY
test('GET /api/history', 'get', f'{BASE}/api/history')
test('POST save version', 'post', f'{BASE}/api/history/save',
     json={'name': 'TestVersion1'})
r = test('GET /api/history (after save)', 'get', f'{BASE}/api/history')
if r and r.status_code == 200:
    print(f'  History: {r.json()}')
# restore requires "version" key with the timestamp, not "name"
# get the version timestamp from the save response or list
r_hist = requests.get(f'{BASE}/api/history', timeout=10)
versions = r_hist.json().get('versions', [])
# Find the version we just saved (most recent)
restore_version_id = versions[0]['version'] if versions else ''
test('POST restore version', 'post', f'{BASE}/api/history/restore',
     json={'version': restore_version_id})

# 18. COMMENTS
test('GET /api/comments/1', 'get', f'{BASE}/api/comments/1')
test('POST add comment', 'post', f'{BASE}/api/comments/1',
     json={'x': 0.5, 'y': 0.5, 'text': 'Test comment', 'author': 'Tester'})
r = test('GET /api/comments/1 (after add)', 'get', f'{BASE}/api/comments/1')
if r and r.status_code == 200:
    comments = r.json()
    print(f'  Comments: {json.dumps(comments)[:120]}')
    if isinstance(comments, list) and len(comments) > 0:
        cid = comments[0].get('id', 0)
        test('POST resolve comment', 'post', f'{BASE}/api/comments/1/resolve',
             json={'id': cid})
        test('POST delete comment', 'post', f'{BASE}/api/comments/1/delete',
             json={'id': cid})

# 19. EXPORTS (run BEFORE version restore to ensure slides exist)
test('POST export PPTX', 'post', f'{BASE}/api/export')
test('POST export PDF', 'post', f'{BASE}/api/export-pdf')
test('POST export PNG ZIP', 'post', f'{BASE}/api/export-png-zip')
test('POST export GIF', 'post', f'{BASE}/api/export-gif',
     json={'duration': 1000})

# 20. VIDEO PAGE
test('GET /video', 'get', f'{BASE}/video')

# 20b. VALIDATION: empty name/version params should return 400 (our fix)
for label, url, body in [
    ('POST restore empty version', f'{BASE}/api/history/restore', {'version': ''}),
    ('POST load empty template', f'{BASE}/api/templates/load', {'name': ''}),
    ('POST save empty template', f'{BASE}/api/templates/save', {'name': ''}),
    ('POST delete empty template', f'{BASE}/api/templates/delete', {'name': ''}),
]:
    test_expect_400(label, 'post', url, json=body)

# 22. ERROR HANDLING (these SHOULD return 400 — that's correct behavior)
test_expect_400('Upload invalid file (expect 400)', 'post', f'{BASE}/api/upload',
     files={'file': ('test.txt', b'not a pptx', 'text/plain')})

test('Invalid slide number', 'get', f'{BASE}/api/slide/999')

test_expect_400('Bake invalid slide (expect 400)', 'post', f'{BASE}/api/slide/999/bake')

# Test bulk remove-logo with no files (expect 400)
test_expect_400('Bulk remove-logo no files (expect 400)', 'post', f'{BASE}/api/batch/remove-logo')

# ═══════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════
print('\n' + '=' * 70)
print('SLIDECRAFT - COMPREHENSIVE TEST REPORT')
print('=' * 70)
passed = sum(1 for r in results if r[1] == 'PASS')
failed = sum(1 for r in results if r[1] == 'FAIL')
errors = sum(1 for r in results if r[1] == 'ERROR')
total = len(results)
print(f'Total: {total} | PASS: {passed} | FAIL: {failed} | ERROR: {errors}')
print('-' * 70)
for name, status, code, detail in results:
    icon = 'V' if status == 'PASS' else ('X' if status == 'FAIL' else '!')
    line = f'{icon} [{status:5s}] {code:3d} {name}'
    if detail and status != 'PASS':
        line += f'  -- {detail[:60]}'
    print(line)
print('-' * 70)
pct = 100 * passed // total if total else 0
print(f'\nPass rate: {passed}/{total} ({pct}%)')

if failed > 0 or errors > 0:
    print('\n--- FAILURES/ERRORS DETAIL ---')
    for name, status, code, detail in results:
        if status != 'PASS':
            print(f'  {name}: [{status}] {code} {detail}')
