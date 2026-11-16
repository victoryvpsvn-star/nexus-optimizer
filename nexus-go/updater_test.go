package main

import "testing"

func TestGoTagNum(t *testing.T) {
	cases := map[string]int{
		"go-v14": 14, "go-v1": 1, " go-v23 ": 23,
		"win-x64-v9": 0, "": 0, "go-v": 0, "go-vabc": 0, "v1.2.3": 0,
	}
	for in, want := range cases {
		if got := goTagNum(in); got != want {
			t.Fatalf("goTagNum(%q) = %d ≠ %d", in, got, want)
		}
	}
}

func TestBuildNum(t *testing.T) {
	if buildNum() < 0 {
		t.Fatal("buildNum âm")
	}
}
