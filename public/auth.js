function togglePassword(){
  password.type = password.type === "password" ? "text" : "password";
}

async function signin(){
  const res = await fetch("/api/signin",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      username:email.value,
      password:password.value
    })
  });

  const data = await res.json();

  if(res.ok){
    if(data.role==="driver") location.href="/driver.html";
    if(data.role==="user") location.href="/user.html";
    if(data.role==="admin") location.href="/admin.html";
  } else {
    alert(data.message);
    resetBox.style.display="block";
  }
}

async function resetPassword(){
  const res = await fetch("/api/reset-password",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      username:email.value,
      otp:otp.value,
      newPassword:newPassword.value
    })
  });
  alert((await res.json()).message);
}
