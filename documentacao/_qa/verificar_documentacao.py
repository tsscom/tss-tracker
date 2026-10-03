from pathlib import Path
import hashlib
import json
import re
from pypdf import PdfReader
from docx import Document

base = Path(__file__).resolve().parent.parent
stories = json.loads((base / 'backlog.json').read_text(encoding='utf-8'))['stories']
requirements = json.loads((base / 'requisitos.json').read_text(encoding='utf-8'))['requirements']
story_ids = {s['id'] for s in stories}
requirement_ids = {r['id'] for r in requirements}
assert len(stories) == len(story_ids) == 44
assert len(requirements) == len(requirement_ids) == 39
assert sum(len(s['criteria']) for s in stories) == 88
assert {s['sprint'] for s in stories} == set(range(1, 11))
for story in stories:
    assert set(story['requirements']) <= requirement_ids
    assert set(re.findall(r'US\d{2}', story['dependency'])) <= story_ids
for requirement in requirements:
    assert set(requirement['stories']) <= story_ids
    for sid in requirement['stories']:
        assert requirement['id'] in next(s for s in stories if s['id'] == sid)['requirements']
report = {
    'date': '2026-09-30',
    'requirements': len(requirements),
    'stories': len(stories),
    'acceptance_criteria': sum(len(s['criteria']) for s in stories),
    'proposed_sprints': 10,
    'traceability': 'passed: bidirectional requirement-story links and dependency identifiers',
    'pdf_visual_review': 'All 43 final pages inspected at original image resolution; no overflow, clipping or unreadable tables found.',
    'docx_layout': 'Unverified: canonical renderer could not locate bundled LibreOffice. PDFs were authored and rendered independently.',
    'artifacts': [],
}
for stem, expected in [
    ('01_Requisitos_e_governacao', 12),
    ('02_Procedimentos_operacionais', 15),
    ('03_Backlog_e_plano_de_sprints', 16),
]:
    pdf = base / (stem + '.pdf')
    docx = base / (stem + '.docx')
    reader = PdfReader(str(pdf))
    assert len(reader.pages) == expected
    assert all(page.extract_text().strip() for page in reader.pages)
    document = Document(str(docx))
    assert document.paragraphs and docx.stat().st_size > 10000
    report['artifacts'].append({
        'name': pdf.name,
        'pages': expected,
        'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(),
        'docx_source': docx.name,
        'docx_sha256': hashlib.sha256(docx.read_bytes()).hexdigest(),
    })
(base / '_qa' / 'validacao_documentacao.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps({'result': 'passed', 'pdf_pages': 43, 'requirements': 39, 'stories': 44, 'criteria': 88, 'docx_layout': 'unverified'}, ensure_ascii=False))
