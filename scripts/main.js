
// function sleep(milliseconds) {
// 	const date = Date.now();
// 	let currentDate = null;
// 	do {
// 		currentDate = Date.now();
// 	} while (currentDate - date < milliseconds);
// }

const myHeading = document.querySelector('h1');

//myHeading.textContent = 'Hello world!';

// let val = 1
// 
// document.querySelector('html').addEventListener('click', function() {
// 	myHeading.textContent = 'Hello world!';
// 	if (val === 1) {
// 		myHeading.textContent = 'Hello world!';
// 		val = 0;
// 	} else {
// 		myHeading.textContent = 'Hello world.';
// 		val = 1;
// 	}
// });



function setUserName() {
	let myName = prompt('Please enter your name:');
	localStorage.setItem('name', myName);
	myHeading.textContent = 'Here is your name ' + myName;
}

let myButton = document.querySelector('button');

myButton.onclick = function() {
	setUserName();
}

if(!localStorage.getItem('name')) {
	setUserName();
} else {
	let storedName = localStorage.getItem('name');
	myHeading.textContent = 'Here is your name ' + storedName;
}


