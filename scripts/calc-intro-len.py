intro_lines = [
    "You are a session categorizer for a software developer's chat history.",
    "Read the conversation below and classify it into a 2-level folder structure.",
    "",
    "I use a 2-level folder structure:",
    '  - Top-level folders capture the general topic (e.g. "Git", "Bugs", "Testing").',
    '  - Second-level folders capture the particular subject within that topic',
    '    (e.g. "Branch Management" under "Git", "UI Crash" under "Bugs").',
    "",
    "Since all chats are about software development, think in terms of both:",
    '  - **Technology/tool** categories: "Git", "Docker", "React", "Python", "Vs Code", "CSS", "API", "Database", "Deployment"',
    '  - **Activity/concept** categories: "Bugs" (problems, fixes, errors), "Testing" (test setup, fixes, additions),',
    '    "Architecture" (plans, design decisions, brainstorming), "Refactoring" (code restructuring, cleanup),',
    '    "Features" (planned features, intents, new capabilities), "Best Practices" (recommendations, patterns, conventions)',
    "",
    "Examples:",
    '- Git branch management → "Git|Branch Management"',
    '- Fixing a UI crash → "Bugs|UI Crash"',
    '- Test fixture setup → "Testing|Fixture Setup"',
    '- Restructuring a module → "Refactoring|Module Restructure"',
    '- Planning a new MCP server → "Features|MCP Server"',
    '- Coding conventions discussion → "Best Practices|Coding Conventions"',
    '- Database schema design → "Architecture|Schema Design"',
    '- Docker container config → "Docker|Container Config"',
    '- Deployment pipeline → "Deployment|Pipeline Setup"',
    '- Python debugging session → "Python|Debugging"',
    "",
    "Rules:",
    "- Return ONLY one line \u2014 no commentary, no markdown, no punctuation.",
    "- Format: TopLevel|SecondLevel (separated by a pipe character).",
    "- Use 1-2 words for TopLevel, 1-3 words for SecondLevel, Title Case.",
    "- Keep TopLevel BROAD \u2014 it should group multiple related chats together.",
    "- Make SecondLevel SPECIFIC \u2014 it distinguishes this chat from others in the same folder.",
    '- Use "Other" as TopLevel ONLY if the session truly does not fit any recognizable',
    "  software development topic.",
    '- Do NOT default to "Other" for sessions about bugs, testing, architecture,',
    "  refactoring, features, or best practices \u2014 those are valid top-level categories.",
    '- If unsure about the second level, return just "TopLevel" without a pipe.',
    "",
    "=== CONVERSATION ===",
    "Session title: Test Session",
    "",
]
intro = "\n".join(intro_lines)
print("Intro length:", len(intro))

# Test 1: 10 messages of 5000 x's
# Intro + '[USER]\n' + 5000*x + '\n\n' ... (but newest first, and stops when over budget)
# The truncation logic builds from newest first, prepending. So the last message added
# will be the oldest one that fits.
# With 10x5000=50K, it will stop after the first message (newest) since 5000 + overhead > 24000 - intro
print("-" * 40)
# What is the limit for one message?
# block = '[USER]\n' + 5000*x + '\n\n' = 7 + 5000 + 2 = 5009 chars
# So even one message of 5000 x's: intro + 5009 = ??? 
total_one = len(intro) + 7 + 5000 + 2
print("Intro + one 5K message:", total_one)
print("Intro + one 5K is less than 25000?", total_one < 25000)
# The MAX_CONVERSATION_CHARS is 24000 for the conversation portion.
# Intro is about ~1700 chars. 24000 - 1700 = 22300-ish available.
# One 5000-char message block = ~5009 chars. 5009 < 22300, so it fits.
# With all 10 messages: intro + 10*5009 = intro + 50090 = ~51800, way over.
# Truncation will include newest first: message 9, 8, etc. until hitting ~24000 conv chars.
# Since 24000 / 5009 ≈ 4.79, about 4-5 messages will fit.
# 5 * 5009 = 25045 > 24000, so only 4 messages ≈ 20036 chars in conversation
print("Approx conv with 4 messages:", 4 * 5009)
print("Total =", len(intro) + 4 * 5009)
# That's > 25000. So the test assert < 25000 is too tight.