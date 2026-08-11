import base64

# Test with the actual conversationState
cs = "~CiAzS/UdUoIjL8KL2hhlrfVXttpSQDmpifFr6nJCi99b+gogI"
print(f"Original: {cs[:50]}...")

# Try to decode with ~ prefix
try:
    decoded = base64.b64decode(cs)
    print(f"With ~: {len(decoded)} bytes")
except Exception as e:
    print(f"With ~ error: {e}")

# Try to decode without ~ prefix
try:
    decoded = base64.b64decode(cs[1:])
    print(f"Without ~: {len(decoded)} bytes")
    print(f"First 50 hex: {decoded[:50].hex()}")
except Exception as e:
    print(f"Without ~ error: {e}")
