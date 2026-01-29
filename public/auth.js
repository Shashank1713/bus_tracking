function showSignin(){
  signinBox.style.display="block";
  signupBox.style.display="none";
  signinTab.classList.add("active");
  signupTab.classList.remove("active");
}

function showSignup(){
  signinBox.style.display="none";
  signupBox.style.display="block";
  signupTab.classList.add("active");
  signinTab.classList.remove("active");
}

async function signin(){
  const res = await fetch("/api/signin",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      username:signinEmail.value,
      password:signinPassword.value
    })
  });

  const data = await res.json();

  if(res.ok){
    if(data.role==="user") location.href="/user.html";
    if(data.role==="driver") location.href="/driver.html";
    if(data.role==="admin") location.href="/admin.html";
  }else{
    alert(data.message);
  }
}

async function signup(){
  const res = await fetch("/api/signup",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      username:signupEmail.value,
      password:signupPassword.value,
      role:signupRole.value
    })
  });

  const data = await res.json();
  alert(data.message);
  if(res.ok) showSignin();
}
