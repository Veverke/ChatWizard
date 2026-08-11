// Test if Node.js Buffer.from handles base64 with ~ prefix
const cs = "~CiAzS/UdUoIjL8KL2hhlrfVXttpSQDmpifFr6nJCi99b+gogI";
console.log("Original:", cs.substring(0, 50) + "...");

try {
    const decoded = Buffer.from(cs, 'base64');
    console.log("With ~ prefix:", decoded.length, "bytes");
    console.log("First 50 hex:", decoded.subarray(0, 50).toString('hex'));
} catch (e) {
    console.log("With ~ prefix error:", e.message);
}

try {
    const decoded = Buffer.from(cs.substring(1), 'base64');
    console.log("Without ~ prefix:", decoded.length, "bytes");
    console.log("First 50 hex:", decoded.subarray(0, 50).toString('hex'));
} catch (e) {
    console.log("Without ~ prefix error:", e.message);
}
