// Everything Goalie uses from Firebase, bundled by `npm run build` into vendor/firebase.js.
export { initializeApp } from 'firebase/app';
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  onAuthStateChanged, signInWithPopup, signInWithCredential, signOut, deleteUser, reauthenticateWithPopup,
  reauthenticateWithCredential, revokeAccessToken, GoogleAuthProvider, OAuthProvider,
} from 'firebase/auth';
export {
  initializeFirestore, doc, collection, onSnapshot, writeBatch, getDocs, getDoc, deleteField,
} from 'firebase/firestore';
