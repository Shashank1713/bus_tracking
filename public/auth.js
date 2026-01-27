function saveUser(user) {
    localStorage.setItem("user", JSON.stringify(user));
}

function getUser() {
    return JSON.parse(localStorage.getItem("user"));
}

function logout() {
    localStorage.clear();
    window.location.href = "signin.html";
}

function requireRole(role) {
    const user = getUser();
    if (!user || user.role !== role) {
        window.location.href = "signin.html";
    }
}
