function togglePassword(){
  password.type = password.type === "password" ? "text" : "password";
}

function showSignup(){
  signupBox.style.display="block";
  title.innerText="Sign Up";
}

function showSignin(){
  signupBox.style.display="none";
  title.innerText="Sign In";
}

async function signup(){
  const res = await fetch("/api/signup",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      username:email.value,
      password:password.value,
      role:role.value
    })
  });

  const data = await res.json();
  alert(data.message);
  if(res.ok) showSignin();
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
    if(data.role==="user") location.href="/user.html";
    if(data.role==="driver") location.href="/driver.html";
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
