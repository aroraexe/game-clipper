// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, GithubAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDeZc5KC6ruyJgga7dht65ekOYQgZaKCHU",
  authDomain: "gameclipper.firebaseapp.com",
  projectId: "gameclipper",
  storageBucket: "gameclipper.firebasestorage.app",
  messagingSenderId: "46620790316",
  appId: "1:46620790316:web:f9bf4ff84722971077cb89",
  measurementId: "G-WT4XJMV9R8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

export { auth, provider, githubProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword };
