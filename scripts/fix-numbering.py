"""Fix TOC numbering cascade bug and renumber section headings."""
import re

path = r'c:\Repos\Personal\ChatWizard\docs\user-guide.md'

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

toc_end = content.find('## 1. Getting Started')

# Fix TOC numbering: iterate from high to low to avoid cascade bugs
toc_section = content[:toc_end]
for old_num, new_num in [(str(i), str(i-1)) for i in range(23, 8, -1)]:
    toc_section = toc_section.replace(f'{old_num}. [', f'{new_num}. [')
    toc_section = toc_section.replace(f'(#{old_num}-', f'(#{new_num}-')
content = toc_section + content[toc_end:]

# Fix section headings in body
for old_num, new_num in [(str(i), str(i-1)) for i in range(23, 8, -1)]:
    content = content.replace(f'## {old_num}. ', f'## {new_num}. ')

# Fix anchor links in body (not TOC, already done)
body = content[toc_end:]
for old_num, new_num in [(str(i), str(i-1)) for i in range(23, 8, -1)]:
    body = body.replace(f'(#{old_num}-', f'(#{new_num}-')
content = content[:toc_end] + body

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Numbering fix applied successfully (reverse iteration)")