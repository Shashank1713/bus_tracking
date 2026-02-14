const API = "http://localhost:3000";

function sendOTP() {
  const mobile = document.getElementById("mobile").value;

  fetch("/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile })
  })
  .then(res => res.json())
  .then(data => {
    document.getElementById("msg").innerText = data.message;
  });
}

function verifyOTP() {
  const mobile = document.getElementById("mobile").value;
  const otp = document.getElementById("otp").value;

  fetch("/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile, otp })
  })
  .then(res => res.json())
  .then(data => {
    document.getElementById("msg").innerText = data.message;

    if (data.role === "admin") {
      window.location.href = "admin.html";
    } else if (data.role === "driver") {
      window.location.href = "driver.html";
    } else {
      window.location.href = "user.html";
    }
  });
}
